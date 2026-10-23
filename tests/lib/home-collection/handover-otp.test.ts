// WS6 T11: the home-collection handover code (spec D7) and the collector's visit-date guard.
// Pure: checkHandoverOtp, the channel status. DB: issueHandoverOtp (hash, expiry, attempts reset,
// one notification_log row with no body) and collectHomeVisit's guard and handover proof.
import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'

// The real sender, wrapped so the test can read the code the patient would receive.
vi.mock('@/lib/notify/send', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/notify/send')>()
  return { ...actual, sendNotification: vi.fn(actual.sendNotification) }
})

import { getDb } from '@/db/client'
import {
  auditLog, departments, encounters, homeCollectionVisits, homeCollectionWindows, labOrders, labTests,
  notificationLog, notificationTemplateConfig, patients, providers, users,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { hashPassword } from '@/lib/password'
import { sendNotification } from '@/lib/notify/send'
import { checkHandoverOtpSendRateLimit } from '@/lib/rate-limit'
import {
  HANDOVER_OTP_MAX_ATTEMPTS, HANDOVER_OTP_TTL_MS, checkHandoverOtp, generateHandoverOtp, handoverChannelStatus, issueHandoverOtp,
} from '@/lib/home-collection/handover-otp'
import { renderNotification } from '@/lib/notify/templates'
import { ensureSampleIds } from '@/lib/queries/lab-lifecycle'
import { assertCollectorVisit, collectHomeVisit } from '@/lib/queries/home-collections'

const NOW = new Date('2099-06-02T05:00:00Z') // 10:30 IST, 2 Jun 2099
const DAY = '2099-06-02'
const later = (ms: number) => new Date(NOW.getTime() + ms)

describe('checkHandoverOtp (pure)', () => {
  const hash = hashPassword('123456')
  const live = { hash, expiresAt: later(HANDOVER_OTP_TTL_MS), attempts: 0 }

  it('ok for the right code, invalid for a wrong or malformed one', () => {
    expect(checkHandoverOtp(live, '123456', NOW)).toBe('ok')
    expect(checkHandoverOtp(live, '123457', NOW)).toBe('invalid')
    expect(checkHandoverOtp(live, '12345', NOW)).toBe('invalid')
  })

  it('no code on file is invalid; past expiry is expired; 5 wrong tries is locked even for the right code', () => {
    expect(checkHandoverOtp({ hash: null, expiresAt: null, attempts: 0 }, '123456', NOW)).toBe('invalid')
    expect(checkHandoverOtp({ ...live, expiresAt: NOW }, '123456', NOW)).toBe('expired')
    expect(checkHandoverOtp({ ...live, attempts: HANDOVER_OTP_MAX_ATTEMPTS - 1 }, '123456', NOW)).toBe('ok')
    expect(checkHandoverOtp({ ...live, attempts: HANDOVER_OTP_MAX_ATTEMPTS }, '123456', NOW)).toBe('locked')
    expect(HANDOVER_OTP_MAX_ATTEMPTS).toBe(5)
    expect(HANDOVER_OTP_TTL_MS).toBe(15 * 60 * 1000)
  })

  it('codes are 6 digits; the channel status is sent > log_only > skipped', () => {
    for (let i = 0; i < 50; i++) expect(generateHandoverOtp()).toMatch(/^\d{6}$/)
    expect(handoverChannelStatus([{ channel: 'sms', status: 'failed' }, { channel: 'whatsapp', status: 'sent' }])).toBe('sent')
    expect(handoverChannelStatus([{ channel: 'sms', status: 'log_only' }, { channel: 'whatsapp', status: 'skipped' }])).toBe('log_only')
    expect(handoverChannelStatus([{ channel: 'sms', status: 'failed' }])).toBe('skipped')
    expect(handoverChannelStatus([])).toBe('skipped')
  })

  it('the template carries the code and the hospital name only', () => {
    expect(renderNotification('home_collection_handover_otp', { hospitalName: 'City Hospital', otp: '042917' }))
      .toBe('City Hospital: Your sample handover code is 042917. Share it with our collector only after your samples are taken. Valid for 15 minutes.')
  })

  it('send limit: 3 per visit in 15 minutes', async () => {
    const visitId = 1_000_000_000 + Math.floor(Math.random() * 1_000_000_000)
    const allowed: boolean[] = []
    for (let i = 0; i < 4; i++) allowed.push((await checkHandoverOtpSendRateLimit(visitId)).allowed)
    expect(allowed).toEqual([true, true, true, false])
  })
})

const RUN = `${Date.now()}`
const TAG = RUN.slice(-6)
const PROBE_COL = `TEST_WS6_HO_COL-${RUN}`
const PROBE_COL2 = `TEST_WS6_HO_COL2-${RUN}`
const PROBE_NAMES = [PROBE_COL, PROBE_COL2]
const P = Array.from({ length: 10 }, (_, i) => `TEST-WS6-HO-${RUN}-${i}`)
let nextP = 0
const fresh = () => P[nextP++]

let providerId = 0
let departmentId = 0
let labTestId = 0
let windowId = 0
let colUser = 0
let colUser2 = 0
let hadTemplateConfig = false
const orderIds: number[] = []
let COL: Session
let COL2: Session

async function scheduledVisit(patientId: string, over: Partial<typeof homeCollectionVisits.$inferInsert> = {}) {
  const db = getDb()
  const [order] = await db.insert(labOrders).values({ patientId, labTestId, orderedByProviderId: providerId }).returning()
  orderIds.push(order.id)
  const sampleId = (await ensureSampleIds(db, [order.id], new Date('2099-06-01T06:00:00Z'))).get(order.id)!
  const [visit] = await db.insert(homeCollectionVisits).values({
    patientId, visitDate: DAY, windowId, windowLabel: `TEST-WS6-${TAG}-w`, windowStart: '10:00', windowEnd: '12:00',
    addressLine1: '12 Test Road', city: 'Test City', stateCode: 'IN-KA', pinCode: '990001',
    contactPhone: '+919845013210', bookedByName: PROBE_COL, collectorUserId: colUser, ...over,
  }).returning()
  await db.update(labOrders).set({ status: 'scheduled', homeCollectionVisitId: visit.id }).where(eq(labOrders.id, order.id))
  return { visit, sampleId }
}

async function visitRow(id: number) {
  const [row] = await getDb().select().from(homeCollectionVisits).where(eq(homeCollectionVisits.id, id))
  return row
}

/** Issue a code and read it back from the (wrapped) sender, as the patient's phone would. */
async function issue(visitId: number, at = NOW) {
  vi.mocked(sendNotification).mockClear()
  const r = await issueHandoverOtp(visitId, COL, at)
  const vars = vi.mocked(sendNotification).mock.calls[0]?.[0].vars as { otp: string } | undefined
  return { r, otp: vars?.otp ?? '' }
}

const wrongOf = (otp: string) => String((Number(otp) + 1) % 1_000_000).padStart(6, '0')

describe.skipIf(!process.env.DATABASE_URL)('handover code and visit-date guard (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values(P.map((id, i) => ({
      id, name: `Ravi Kumar${TAG}x${i}`, dob: '1980-06-03', gender: 'male' as const, phone: '+919845013210',
      addressLine1: 'Reg line', city: 'Reg City', stateCode: 'IN-KA', pinCode: '990001', uhid: `TWS6HO${TAG}${i}`,
    })))
    const [dept] = await db.insert(departments).values({ code: `TW6H${TAG}`, name: `TEST_WS6 Path ${RUN}` }).returning()
    departmentId = dept.id
    const [pr] = await db.insert(providers).values({ name: `TEST_WS6 Dr Handover ${RUN}`, specialty: 'Pathology', colorTag: '#000000', departmentId }).returning()
    providerId = pr.id
    const [t] = await db.insert(labTests).values({ name: `TEST_WS6 handover lab ${RUN}`, code: `TEST-WS6-HO-${RUN}`, container: 'edta_lavender', sampleType: 'blood' }).returning()
    labTestId = t.id
    const [w] = await db.insert(homeCollectionWindows).values({ label: `TEST-WS6-${TAG}-w`, startTime: '10:00', endTime: '12:00', capacity: 50 }).returning()
    windowId = w.id
    const us = await db.insert(users).values([
      { name: PROBE_COL, email: `test-ws6-ho-col-${RUN}@example.invalid`, role: 'collector' },
      { name: PROBE_COL2, email: `test-ws6-ho-col2-${RUN}@example.invalid`, role: 'collector' },
    ]).returning()
    ;[colUser, colUser2] = us.map((u) => u.id)
    COL = { role: 'collector', name: PROBE_COL, userId: colUser }
    COL2 = { role: 'collector', name: PROBE_COL2, userId: colUser2 }
    // One channel for this template, so one send is one notification_log row.
    hadTemplateConfig = (await db.select().from(notificationTemplateConfig).where(eq(notificationTemplateConfig.templateKey, 'home_collection_handover_otp'))).length > 0
    if (!hadTemplateConfig) {
      await db.insert(notificationTemplateConfig).values({ templateKey: 'home_collection_handover_otp', channels: ['sms'], updatedByName: PROBE_COL })
    }
  })

  afterAll(async () => {
    const db = getDb()
    if (!hadTemplateConfig) await db.delete(notificationTemplateConfig).where(eq(notificationTemplateConfig.templateKey, 'home_collection_handover_otp'))
    await db.delete(notificationLog).where(inArray(notificationLog.patientId, P))
    if (orderIds.length > 0) await db.delete(labOrders).where(inArray(labOrders.id, orderIds))
    await db.delete(homeCollectionVisits).where(inArray(homeCollectionVisits.patientId, P))
    await db.delete(encounters).where(inArray(encounters.patientId, P))
    await db.delete(homeCollectionWindows).where(eq(homeCollectionWindows.id, windowId))
    await db.delete(auditLog).where(inArray(auditLog.userName, PROBE_NAMES))
    await db.delete(users).where(inArray(users.id, [colUser, colUser2]))
    await db.delete(labTests).where(eq(labTests.id, labTestId))
    await db.delete(providers).where(eq(providers.id, providerId))
    await db.delete(departments).where(eq(departments.id, departmentId))
    await db.delete(patients).where(inArray(patients.id, P))
  })

  it('a visit dated tomorrow (IST) is not due: no code is sent and nothing is collected', async () => {
    const { visit, sampleId } = await scheduledVisit(fresh(), { visitDate: '2099-06-03' })
    expect(await assertCollectorVisit(visit.id, COL, DAY)).toEqual({ ok: false, error: 'not_due', visitDate: '2099-06-03' })
    expect((await issue(visit.id)).r).toEqual({ ok: false, error: 'not_due', visitDate: '2099-06-03' })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(await collectHomeVisit(visit.id, [sampleId], COL, NOW, { waiverReason: 'sms_unavailable' }))
      .toEqual({ ok: false, error: 'not_due', visitDate: '2099-06-03' })
    // On its own IST day the same visit passes the guard.
    expect((await assertCollectorVisit(visit.id, COL, '2099-06-03')).ok).toBe(true)
    expect((await visitRow(visit.id)).status).toBe('booked')
  })

  it('sending stores only a hash with a 15-minute expiry, and records one notification_log row with no body', async () => {
    const { visit } = await scheduledVisit(fresh())
    const { r, otp } = await issue(visit.id)
    expect(r).toEqual({ ok: true, channelStatus: 'log_only' })
    expect(otp).toMatch(/^\d{6}$/)
    const row = await visitRow(visit.id)
    expect(row.handoverOtpHash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/)
    expect(row.handoverOtpHash).not.toContain(otp)
    expect(row.handoverOtpExpiresAt?.getTime()).toBe(NOW.getTime() + 15 * 60 * 1000)
    expect(row.handoverOtpAttempts).toBe(0)

    const logs = await getDb().select().from(notificationLog)
      .where(and(eq(notificationLog.patientId, visit.patientId), eq(notificationLog.templateKey, 'home_collection_handover_otp')))
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ channel: 'sms', status: 'log_only', destinationMasked: '+91******3210' })
    expect(Object.keys(logs[0]).sort()).toEqual(['channel', 'createdAt', 'dedupeKey', 'destinationMasked', 'errorClass', 'id', 'patientId', 'providerMessageId', 'status', 'templateKey'])
    expect(JSON.stringify(logs)).not.toContain(otp)

    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE_COL), eq(auditLog.patientId, visit.patientId)))
    expect(audits.map((a) => [a.action, a.details])).toEqual([['sent home collection handover code', `visit=${visit.id}`]])
  })

  it('no code and no waiver is otp_required; a waiver collects and stores the reason', async () => {
    const { visit, sampleId } = await scheduledVisit(fresh())
    expect(await collectHomeVisit(visit.id, [sampleId], COL, NOW, {})).toEqual({ ok: false, error: 'otp_required' })
    expect((await visitRow(visit.id)).status).toBe('booked')
    const r = await collectHomeVisit(visit.id, [sampleId], COL, NOW, { waiverReason: 'sms_unavailable' })
    expect(r.ok).toBe(true)
    const row = await visitRow(visit.id)
    expect(row).toMatchObject({ status: 'collected', handoverWaiverReason: 'sms_unavailable', handoverVerifiedAt: null })
    const [audit] = await getDb().select().from(auditLog)
      .where(and(eq(auditLog.userName, PROBE_COL), eq(auditLog.action, 'collected home samples'), eq(auditLog.patientId, visit.patientId)))
    expect(audit.details).toMatch(/ handover=waived:sms_unavailable$/)
  })

  it('a wrong code is counted (and kept) on each refusal; the sixth try is locked; a new send resets it', async () => {
    const { visit, sampleId } = await scheduledVisit(fresh())
    const { otp } = await issue(visit.id)
    const wrong = wrongOf(otp)
    for (let i = 1; i <= 5; i++) {
      expect(await collectHomeVisit(visit.id, [sampleId], COL, later(60_000), { otp: wrong })).toEqual({ ok: false, error: 'otp_invalid' })
      expect((await visitRow(visit.id)).handoverOtpAttempts).toBe(i)
    }
    // Locked: even the right code is refused now, and nothing else changed.
    expect(await collectHomeVisit(visit.id, [sampleId], COL, later(60_000), { otp })).toEqual({ ok: false, error: 'otp_locked' })
    expect(await visitRow(visit.id)).toMatchObject({ status: 'booked', handoverOtpAttempts: 5, handoverVerifiedAt: null })
    // Ruling R24: a locked code cannot be side-stepped with a waiver.
    expect(await collectHomeVisit(visit.id, [sampleId], COL, later(60_000), { waiverReason: 'sms_unavailable' })).toEqual({ ok: false, error: 'otp_locked' })
    expect(await visitRow(visit.id)).toMatchObject({ status: 'booked', handoverWaiverReason: null })
    const [order] = await getDb().select().from(labOrders).where(eq(labOrders.homeCollectionVisitId, visit.id))
    expect(order.status).toBe('scheduled')

    const again = await issue(visit.id, later(120_000))
    expect((await visitRow(visit.id)).handoverOtpAttempts).toBe(0)
    expect((await collectHomeVisit(visit.id, [sampleId], COL, later(180_000), { otp: again.otp })).ok).toBe(true)
  })

  it('the right code collects and sets handover_verified_at (the code is spent); an expired code is refused', async () => {
    const { visit, sampleId } = await scheduledVisit(fresh())
    const { otp } = await issue(visit.id)
    expect(await collectHomeVisit(visit.id, [sampleId], COL, later(HANDOVER_OTP_TTL_MS + 1000), { otp })).toEqual({ ok: false, error: 'otp_expired' })
    const at = later(5 * 60_000)
    const r = await collectHomeVisit(visit.id, [sampleId], COL, at, { otp })
    expect(r.ok).toBe(true)
    const row = await visitRow(visit.id)
    expect(row).toMatchObject({ status: 'collected', handoverOtpHash: null, handoverOtpExpiresAt: null, handoverWaiverReason: null })
    expect(row.handoverVerifiedAt?.getTime()).toBe(at.getTime())
    const audits = await getDb().select().from(auditLog).where(eq(auditLog.patientId, visit.patientId))
    expect(JSON.stringify(audits)).not.toContain(otp)
    expect(audits.find((a) => a.action === 'collected home samples')?.details).toMatch(/ handover=otp$/)
  })

  it("another collector's visit: no code is sent and the collect is refused", async () => {
    const { visit, sampleId } = await scheduledVisit(fresh())
    vi.mocked(sendNotification).mockClear()
    expect(await issueHandoverOtp(visit.id, COL2, NOW)).toEqual({ ok: false, error: 'not_assigned' })
    expect(sendNotification).not.toHaveBeenCalled()
    expect(await collectHomeVisit(visit.id, [sampleId], COL2, NOW, { waiverReason: 'no_phone' })).toEqual({ ok: false, error: 'not_assigned' })
    expect(await assertCollectorVisit(visit.id, COL2, DAY)).toEqual({ ok: false, error: 'not_assigned' })
    expect(await assertCollectorVisit(2147483000, COL, DAY)).toEqual({ ok: false, error: 'not_found' })
    expect(await assertCollectorVisit(visit.id, COL, DAY)).toEqual({ ok: true, patientId: visit.patientId })
  })

  it('a visit without a usable mobile number is no_phone', async () => {
    const { visit } = await scheduledVisit(fresh(), { contactPhone: '0802345678' })
    expect((await issue(visit.id)).r).toEqual({ ok: false, error: 'no_phone' })
    expect((await visitRow(visit.id)).handoverOtpHash).toBeNull()
  })
})
