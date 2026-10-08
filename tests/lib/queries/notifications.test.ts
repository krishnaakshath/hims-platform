import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, notificationDeliveries, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'
import type { Notifier } from '@/lib/notify/notifier'
import { notifyPatient, notifyPatientSafely, setNotificationOptOut, type NotifyPatientRequest } from '@/lib/queries/notifications'

const RUN = `${Date.now()}`
const PROBE_USER = `TEST_SP5_NOTIFY-${RUN}`
const S: Session = { role: 'frontdesk', name: PROBE_USER, userId: null }
const REACHABLE = `TEST-SP5-${RUN}-NA`
const NO_PHONE = `TEST-SP5-${RUN}-NB`
const OPTED_OUT = `TEST-SP5-${RUN}-NC`
const ALL = [REACHABLE, NO_PHONE, OPTED_OUT]

const req = (key: string, patientId = REACHABLE): NotifyPatientRequest<'home_collection_booked'> => ({
  patientId,
  templateKey: 'home_collection_booked',
  vars: { hospitalName: 'Test Hospital', visitDate: '2099-01-02', windowLabel: 'Morning' },
  related: { type: 'home_collection_visit', id: 42 },
  dedupeKey: `TEST_SP5_${RUN}-${key}`,
})
const deliveries = (key: string) => getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.dedupeKey, `TEST_SP5_${RUN}-${key}`))
const spyNotifier = () => ({ send: vi.fn<Notifier['send']>(async () => ({ channel: 'log' as const, delivered: false })) })

describe.skipIf(!process.env.DATABASE_URL)('notify (DB)', () => {
  beforeAll(async () => {
    await getDb().insert(patients).values([
      { id: REACHABLE, name: 'TEST_SP5 Reachable', dob: '1980-01-01', phone: '98450 13210' },
      { id: NO_PHONE, name: 'TEST_SP5 No phone', dob: '1980-01-01', phone: null },
      { id: OPTED_OUT, name: 'TEST_SP5 Opted out', dob: '1980-01-01', phone: '+919845013211' },
    ])
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(notificationDeliveries).where(inArray(notificationDeliveries.patientId, ALL))
    await db.delete(auditLog).where(eq(auditLog.userName, PROBE_USER))
    await db.delete(patients).where(inArray(patients.id, ALL))
  })

  it('logs one delivery for a reachable patient, masked and without the text', async () => {
    const n = spyNotifier()
    expect(await notifyPatient('t', req('k1'), n)).toBe('logged')
    expect(n.send).toHaveBeenCalledWith({
      patientId: REACHABLE,
      templateKey: 'home_collection_booked',
      text: 'Test Hospital: Home sample collection booked for 2 Jan 2099, Morning. Our collector will call before arriving.',
      destination: '+919845013210',
    })
    const [row] = await deliveries('k1')
    expect(row).toMatchObject({ status: 'logged', channel: 'log', destinationMasked: '+91******3210', relatedType: 'home_collection_visit', relatedId: 42, errorCode: null, createdByName: 't' })
    expect(JSON.stringify(row)).not.toContain('Home sample collection')
  })

  it('a delivered result is sent; an undelivered one with an error code is failed', async () => {
    expect(await notifyPatient('t', req('k1b'), { send: async () => ({ channel: 'sms', delivered: true }) })).toBe('sent')
    expect((await deliveries('k1b'))[0]).toMatchObject({ status: 'sent', channel: 'sms' })
    expect(await notifyPatient('t', req('k1c'), { send: async () => ({ channel: 'whatsapp', delivered: false, errorCode: 'rate_limited' }) })).toBe('failed')
    expect((await deliveries('k1c'))[0]).toMatchObject({ status: 'failed', channel: 'whatsapp', errorCode: 'rate_limited' })
  })

  it('opt-out suppresses', async () => {
    expect(await setNotificationOptOut(OPTED_OUT, true, S)).toBe(true)
    const [p] = await getDb().select({ optOut: patients.notificationOptOut, at: patients.notificationOptOutAt }).from(patients).where(eq(patients.id, OPTED_OUT))
    expect(p.optOut).toBe(true)
    expect(p.at).toBeInstanceOf(Date)
    const n = spyNotifier()
    expect(await notifyPatient('t', req('k2', OPTED_OUT), n)).toBe('suppressed_opt_out')
    expect(n.send).not.toHaveBeenCalled()
    expect((await deliveries('k2'))[0]).toMatchObject({ status: 'suppressed_opt_out', destinationMasked: null })

    expect(await setNotificationOptOut(OPTED_OUT, false, S)).toBe(true)
    const [q] = await getDb().select({ optOut: patients.notificationOptOut, at: patients.notificationOptOutAt }).from(patients).where(eq(patients.id, OPTED_OUT))
    expect(q).toEqual({ optOut: false, at: null })
    expect(await setNotificationOptOut('TEST-SP5-NOPE', true, S)).toBe(false)

    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.filter((a) => a.action === 'changed notification preference').map((a) => [a.patientId, a.details])).toEqual(
      expect.arrayContaining([[OPTED_OUT, 'optOut=true'], [OPTED_OUT, 'optOut=false']]),
    )
  })

  it('no phone is skipped', async () => {
    const n = spyNotifier()
    expect(await notifyPatient('t', req('k3', NO_PHONE), n)).toBe('skipped_no_contact')
    expect(n.send).not.toHaveBeenCalled()
    expect((await deliveries('k3'))[0]).toMatchObject({ status: 'skipped_no_contact' })
  })

  it('the same dedupe key notifies once', async () => {
    const n = spyNotifier()
    expect(await notifyPatient('t', req('k4'), n)).toBe('logged')
    expect(await notifyPatient('t', req('k4'), n)).toBe('duplicate')
    expect(n.send).toHaveBeenCalledTimes(1)
    expect(await deliveries('k4')).toHaveLength(1)
  })

  it('a throwing notifier is logged as failed and does not throw', async () => {
    expect(await notifyPatientSafely(S, req('k5'), { send: async () => { throw new Error('boom') } })).toBe('failed')
    expect((await deliveries('k5'))[0]).toMatchObject({ status: 'failed', errorCode: 'exception', destinationMasked: '+91******3210' })
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.userName, PROBE_USER))
    expect(audits.find((a) => a.action === 'patient notification' && a.details?.includes('outcome=failed'))).toMatchObject({
      patientId: REACHABLE,
      details: 'template=home_collection_booked outcome=failed related=home_collection_visit:42',
    })
  })

  it('a failure before sending returns error and logs only the error name', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    // No such patient: the delivery insert fails its foreign key.
    expect(await notifyPatientSafely(S, req('k6', 'TEST-SP5-NOPE'), spyNotifier())).toBe('error')
    expect(err.mock.calls.length).toBeGreaterThan(0)
    for (const call of err.mock.calls) expect(call.map(String).join(' ')).not.toMatch(/TEST-SP5-NOPE|insert|notification_deliveries/)
    err.mockRestore()
  })
})
