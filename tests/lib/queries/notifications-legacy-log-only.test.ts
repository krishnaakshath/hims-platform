// Foundations T8 fix: the legacy SP5 path (notifyPatient → getNotifier) never reaches a real
// channel adapter, even when SMS is configured. It ignores channel preferences and template
// config, so it stays log-only until Task 9 moves its callers to sendNotification.
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'

const smsSend = vi.fn(async () => ({ ok: true, providerMessageId: 'SM_should_not_happen' }))
vi.mock('@/lib/notify/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notify/registry')>()
  const fake = (name: 'sms' | 'whatsapp' | 'email' | 'in_app') => ({ name, configured: () => true, send: name === 'sms' ? smsSend : vi.fn(async () => ({ ok: true })) })
  return { ...actual, getChannelRegistry: () => ({ sms: fake('sms'), whatsapp: fake('whatsapp'), email: fake('email'), in_app: fake('in_app') }) }
})

import { getDb } from '@/db/client'
import { auditLog, notificationDeliveries, patientNotificationPreferences, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import { notifyPatient } from '@/lib/queries/notifications'
import { setPatientChannelPreferences } from '@/lib/queries/notification-log'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_T8_LEGACY-${RUN}`
const S: Session = { role: 'admin', name: PROBE_USER, userId: null }
const SMS_OFF = `TEST-T8L-${RUN}-A`
const SMS_ON = `TEST-T8L-${RUN}-B`
const key = (k: string) => `TEST_T8L_${RUN}-${k}`

describe.skipIf(!process.env.DATABASE_URL)('legacy notifyPatient stays log-only (DB)', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values([
      { id: SMS_OFF, name: 'TEST_T8L Off', dob: '1980-01-01', phone: '+919845013210' },
      { id: SMS_ON, name: 'TEST_T8L On', dob: '1980-01-01', phone: '+919845013211' },
    ])
    expect(await setPatientChannelPreferences(SMS_OFF, { sms: false }, S)).toBe(true)
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.patientId, [SMS_OFF, SMS_ON]))
    await db.delete(patientNotificationPreferences).where(inArray(patientNotificationPreferences.patientId, [SMS_OFF, SMS_ON]))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await db.delete(patients).where(inArray(patients.id, [SMS_OFF, SMS_ON]))
  })

  it.each([
    ['sms=false', SMS_OFF, 'off'],
    ['sms=true', SMS_ON, 'on'],
  ])('with SMS configured and %s, the default notifier never calls the SMS adapter', async (_label, patientId, k) => {
    smsSend.mockClear()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const outcome = await notifyPatient('t', {
      patientId,
      templateKey: 'lab_report_ready',
      vars: { hospitalName: 'Test Hospital' },
      related: { type: 'lab_report', id: 1 },
      dedupeKey: key(k),
    })
    info.mockRestore()
    expect(outcome).toBe('logged')
    expect(smsSend).not.toHaveBeenCalled()
    const [row] = await getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.dedupeKey, key(k)))
    expect(row).toMatchObject({ status: 'logged', channel: 'log' })
  })
})
