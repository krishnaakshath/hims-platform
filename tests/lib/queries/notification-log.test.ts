// Foundations T8: notification_log, template config and per-patient channel preferences (DB).
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, notificationLog, notificationTemplateConfig, patientNotificationPreferences, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import {
  DEFAULT_TEMPLATE_CHANNELS,
  dbNotificationStore,
  getPatientChannelPreferences,
  listNotificationTemplateConfigs,
  listRecentNotifications,
  recordNotificationAttempts,
  setPatientChannelPreferences,
  upsertNotificationTemplateConfig,
} from '@/lib/queries/notification-log'
import { sendNotification } from '@/lib/notify/send'
import { getChannelRegistry } from '@/lib/notify/registry'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_T8_NOTIFY-${RUN}`
const S: Session = { role: 'admin', name: PROBE_USER, userId: null }
const P1 = `TEST-T8-${RUN}-A`
const P2 = `TEST-T8-${RUN}-B`

describe.skipIf(!process.env.DATABASE_URL)('notification log (DB)', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values([
      { id: P1, name: 'TEST_T8 One', dob: '1980-01-01', phone: '+919845013210' },
      { id: P2, name: 'TEST_T8 Two', dob: '1980-01-01', phone: null },
    ])
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(notificationLog).where(inArray(notificationLog.patientId, [P1, P2]))
    await db.delete(patientNotificationPreferences).where(inArray(patientNotificationPreferences.patientId, [P1, P2]))
    await db.delete(notificationTemplateConfig).where(eq(notificationTemplateConfig.updatedByName, PROBE_USER))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await db.delete(patients).where(inArray(patients.id, [P1, P2]))
  })

  it('records attempts and lists the latest first, with no body column', async () => {
    await recordNotificationAttempts([
      { patientId: P1, templateKey: 'lab_report_ready', channel: 'sms', destinationMasked: '+91******3210', status: 'log_only', providerMessageId: null, errorClass: 'not_configured' },
      { patientId: P1, templateKey: 'form_sent', channel: 'email', destinationMasked: 'r***@x.com', status: 'sent', providerMessageId: '<m1>', errorClass: null },
    ])
    const rows = await listRecentNotifications(P1, 10)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.templateKey).sort()).toEqual(['form_sent', 'lab_report_ready'])
    expect(Object.keys(rows[0]).sort()).toEqual(['channel', 'createdAt', 'destinationMasked', 'errorClass', 'id', 'patientId', 'providerMessageId', 'status', 'templateKey'])
    expect(Object.keys(notificationLog)).not.toContain('body')
  })

  it('rejects an unknown status or channel at the database', async () => {
    await expect(recordNotificationAttempts([{ patientId: P1, templateKey: 'form_sent', channel: 'sms', destinationMasked: null, status: 'delivered' as never, providerMessageId: null, errorClass: null }])).rejects.toThrow()
    await expect(recordNotificationAttempts([{ patientId: P1, templateKey: 'form_sent', channel: 'fax' as never, destinationMasked: null, status: 'sent', providerMessageId: null, errorClass: null }])).rejects.toThrow()
  })

  it('channel preferences default to on, follow the master opt-out, and save with an audit row', async () => {
    expect(await getPatientChannelPreferences(P1)).toEqual({ optOut: false, sms: true, whatsapp: true, email: true })
    expect(await getPatientChannelPreferences('TEST-T8-NOPE')).toBeNull()
    expect(await setPatientChannelPreferences(P1, { whatsapp: false }, S)).toBe(true)
    expect(await getPatientChannelPreferences(P1)).toEqual({ optOut: false, sms: true, whatsapp: false, email: true })
    expect(await setPatientChannelPreferences(P1, { email: false, whatsapp: true }, S)).toBe(true)
    expect(await getPatientChannelPreferences(P1)).toEqual({ optOut: false, sms: true, whatsapp: true, email: false })
    expect(await setPatientChannelPreferences('TEST-T8-NOPE', { sms: false }, S)).toBe(false)
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.filter((a) => a.action === 'changed notification channels').map((a) => a.details)).toEqual(['whatsapp=false', 'whatsapp=true email=false'])
  })

  it('template config falls back to defaults and upserts with audit', async () => {
    const before = await listNotificationTemplateConfigs()
    const cfg = before.find((c) => c.templateKey === 'appointment_reminder')
    expect(cfg).toBeDefined()
    expect(before.length).toBeGreaterThanOrEqual(9)
    await upsertNotificationTemplateConfig({ templateKey: 'appointment_reminder', channels: ['whatsapp', 'sms'], dltTemplateId: '1107000', whatsappTemplateName: 'reminder_v1' }, S)
    const after = (await listNotificationTemplateConfigs()).find((c) => c.templateKey === 'appointment_reminder')
    expect(after).toMatchObject({ channels: ['sms', 'whatsapp'], dltTemplateId: '1107000', whatsappTemplateName: 'reminder_v1' })
    expect(await dbNotificationStore.templateConfig('appointment_reminder')).toEqual({ channels: ['sms', 'whatsapp'], dltTemplateId: '1107000', whatsappTemplateName: 'reminder_v1' })
    expect(DEFAULT_TEMPLATE_CHANNELS.length).toBeGreaterThan(0)
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.some((a) => a.action === 'changed notification template' && a.details === 'template=appointment_reminder channels=sms,whatsapp')).toBe(true)
  })

  it('end to end: unconfigured env sends nothing and logs log_only rows with a masked destination', async () => {
    const r = await sendNotification(
      { patientId: P1, templateKey: 'appointment_reminder', vars: { hospitalName: 'H', visitDate: '2099-01-02', timeLabel: '10:30' }, destination: { phone: '+919845013210' } },
      { registry: getChannelRegistry({ env: {} }) },
    )
    expect(r.attempts).toEqual([{ channel: 'sms', status: 'log_only' }, { channel: 'whatsapp', status: 'log_only' }])
    const rows = (await listRecentNotifications(P1, 10)).filter((x) => x.templateKey === 'appointment_reminder')
    expect(rows.map((x) => [x.channel, x.status, x.destinationMasked]).sort()).toEqual([['sms', 'log_only', '+91******3210'], ['whatsapp', 'log_only', '+91******3210']])
  })
})
