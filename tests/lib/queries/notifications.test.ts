// SP5 notices, Foundations T9: notifyPatient / notifyPatientSafely deliver through sendNotification.
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, notificationLog, patientNotificationPreferences, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { ChannelAdapter, ChannelRegistry, DeliveryChannel } from '@/lib/notify/registry'
import { notifyPatient, notifyPatientSafely, setNotificationOptOut, type NotifyPatientRequest } from '@/lib/queries/notifications'
import { setPatientChannelPreferences } from '@/lib/queries/notification-log'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP5_NOTIFY-${RUN}`
const S: Session = { role: 'frontdesk', name: PROBE_USER, userId: null }
const REACHABLE = `TEST-SP5-${RUN}-NA`
const NO_PHONE = `TEST-SP5-${RUN}-NB`
const OPTED_OUT = `TEST-SP5-${RUN}-NC`
const SMS_OFF = `TEST-SP5-${RUN}-ND`
const ALL = [REACHABLE, NO_PHONE, OPTED_OUT, SMS_OFF]

const req = (key: string, patientId = REACHABLE): NotifyPatientRequest<'home_collection_booked'> => ({
  patientId,
  templateKey: 'home_collection_booked',
  vars: { hospitalName: 'Test Hospital', visitDate: '2099-01-02', windowLabel: 'Morning' },
  related: { type: 'home_collection_visit', id: 42 },
  dedupeKey: `TEST_SP5_${RUN}-${key}`,
})
const logs = (patientId: string) => getDb().select().from(notificationLog).where(eq(notificationLog.patientId, patientId))

function registry(sendImpl?: ChannelAdapter['send']) {
  const sms = vi.fn<ChannelAdapter['send']>(sendImpl ?? (async () => ({ ok: true, providerMessageId: 'SM1' })))
  const adapter = (name: DeliveryChannel, send: ChannelAdapter['send']) => ({ name, configured: () => true, send })
  const other = vi.fn<ChannelAdapter['send']>(async () => ({ ok: true }))
  const reg = { sms: adapter('sms', sms), whatsapp: adapter('whatsapp', other), email: adapter('email', other), in_app: adapter('in_app', other) } satisfies ChannelRegistry
  return { reg, sms, other }
}

describe.skipIf(!process.env.DATABASE_URL)('notify via sendNotification (DB)', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values([
      { id: REACHABLE, name: 'TEST_SP5 Reachable', dob: '1980-01-01', phone: '98450 13210' },
      { id: NO_PHONE, name: 'TEST_SP5 No phone', dob: '1980-01-01', phone: null },
      { id: OPTED_OUT, name: 'TEST_SP5 Opted out', dob: '1980-01-01', phone: '+919845013211' },
      { id: SMS_OFF, name: 'TEST_SP5 Sms off', dob: '1980-01-01', phone: '+919845013212' },
    ])
    await setPatientChannelPreferences(SMS_OFF, { sms: false }, S)
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(notificationLog).where(inArray(notificationLog.patientId, ALL))
    await db.delete(patientNotificationPreferences).where(inArray(patientNotificationPreferences.patientId, ALL))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await db.delete(patients).where(inArray(patients.id, ALL))
  })

  it('sends on the default channels, masked and without the text', async () => {
    const { reg, sms } = registry()
    expect(await notifyPatient('t', req('k1'), { registry: reg })).toBe('sent')
    expect(sms).toHaveBeenCalledWith(expect.objectContaining({ to: '+919845013210', templateKey: 'home_collection_booked' }))
    const rows = await logs(REACHABLE)
    expect(rows.find((r) => r.channel === 'sms')).toMatchObject({ status: 'sent', destinationMasked: '+91******3210', dedupeKey: `TEST_SP5_${RUN}-k1` })
    expect(JSON.stringify(rows)).not.toContain('Home sample collection')
  })

  it('the same dedupe key notifies once', async () => {
    const { reg, sms } = registry()
    expect(await notifyPatient('t', req('k4'), { registry: reg })).toBe('sent')
    sms.mockClear()
    expect(await notifyPatient('t', req('k4'), { registry: reg })).toBe('duplicate')
    expect(sms).not.toHaveBeenCalled()
  })

  it('a failing adapter is failed; a throwing one does not throw out of notifyPatientSafely', async () => {
    const { reg } = registry(async () => ({ ok: false, errorClass: 'rate_limited' }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await notifyPatientSafely(S, req('k5'), { registry: registry(async () => { throw new Error('boom') }).reg })).toBe('sent') // whatsapp still succeeds
    err.mockRestore()
    expect(await notifyPatient('t', req('k5b'), { registry: { ...reg, whatsapp: { ...reg.whatsapp, send: async () => ({ ok: false, errorClass: 'x' }) } } })).toBe('failed')
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.find((a) => a.action === 'patient notification')).toMatchObject({ patientId: REACHABLE, details: 'template=home_collection_booked outcome=sent related=home_collection_visit:42' })
  })

  it('master opt-out suppresses and calls no adapter', async () => {
    expect(await setNotificationOptOut(OPTED_OUT, true, S)).toBe(true)
    const { reg, sms, other } = registry()
    expect(await notifyPatient('t', req('k2', OPTED_OUT), { registry: reg })).toBe('suppressed_opt_out')
    expect(sms).not.toHaveBeenCalled()
    expect(other).not.toHaveBeenCalled()
    expect(await setNotificationOptOut(OPTED_OUT, false, S)).toBe(true)
    expect(await setNotificationOptOut('TEST-SP5-NOPE', true, S)).toBe(false)
  })

  it('per-channel preference is honoured (sms off -> sms adapter not called)', async () => {
    const { reg, sms, other } = registry()
    await notifyPatient('t', req('k7', SMS_OFF), { registry: reg })
    expect(sms).not.toHaveBeenCalled()
    expect(other).toHaveBeenCalled()
  })

  it('no phone is skipped', async () => {
    const { reg } = registry()
    expect(await notifyPatient('t', req('k3', NO_PHONE), { registry: reg })).toBe('skipped_no_contact')
  })

  it('no such patient returns skipped, and notifyPatientSafely never throws', async () => {
    const { reg } = registry()
    expect(await notifyPatientSafely(S, req('k6', 'TEST-SP5-NOPE'), { registry: reg })).toBe('skipped_no_contact')
  })
})
