// WS7 T10 (spec D16): hospital broadcast audience -- pure rules plus the DB-backed filter query.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, broadcasts, departments, encounters, followUpOrders, notificationLog, patientNotificationPreferences, patients, providers, rooms,
} from '@/db/schema'
import {
  audienceSummaryLine, broadcastOutcome, classifyRecipient, describeAudienceFilters, parseAudienceQuery, summariseAudience, validateAudienceFilters,
} from '@/lib/broadcasts/audience'
import { DuplicateBroadcastError, listBroadcastRecipientCandidates, sendBroadcast } from '@/lib/queries/broadcasts'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { todayIsoIn } from '@/lib/india-time'
import type { ChannelAdapter, ChannelRegistry } from '@/lib/notify/registry'

describe('classifyRecipient', () => {
  const base = { phone: '+919876543210', optedOut: false, smsOff: false, archived: false }
  it('sends to a patient with a usable phone and no opt-out', () => expect(classifyRecipient(base)).toBe('send'))
  it('skips opted-out patients (master opt-out or SMS off) before checking the phone', () => {
    expect(classifyRecipient({ ...base, optedOut: true })).toBe('opted_out')
    expect(classifyRecipient({ ...base, smsOff: true, phone: null })).toBe('opted_out')
  })
  it('skips a patient with no usable phone', () => expect(classifyRecipient({ ...base, phone: null })).toBe('no_phone'))
  it('archived wins over everything', () => expect(classifyRecipient({ ...base, optedOut: true, archived: true })).toBe('archived'))
})

describe('summariseAudience', () => {
  it('counts match, opted out, no phone and sendable; archived is not a match', () => {
    const s = summariseAudience(['send', 'send', 'opted_out', 'no_phone', 'archived'])
    expect(s).toEqual({ match: 4, optedOut: 1, noPhone: 1, sendable: 2 })
    expect(audienceSummaryLine({ match: 212, optedOut: 18, noPhone: 7, sendable: 187 })).toBe('212 match · 18 opted out · 7 no phone')
  })
})

describe('parseAudienceQuery / validateAudienceFilters', () => {
  it('reads numbers and strings, ignoring empty values', () => {
    const r = parseAudienceQuery(new URLSearchParams('ageMin=60&ageMax=120&pinCodePrefix=560&ward='), { trialsEnabled: false })
    expect(r).toEqual({ ok: true, filters: { ageMin: 60, ageMax: 120, pinCodePrefix: '560' } })
  })
  it('refuses trial filters while trials are off, and accepts them when on', () => {
    expect(parseAudienceQuery(new URLSearchParams('trialId=nct1'), { trialsEnabled: false })).toEqual({ ok: false, code: 'trial_filters_disabled' })
    expect(parseAudienceQuery(new URLSearchParams('overallStatus=red'), { trialsEnabled: false })).toEqual({ ok: false, code: 'trial_filters_disabled' })
    expect(parseAudienceQuery(new URLSearchParams('trialId=nct1'), { trialsEnabled: true }).ok).toBe(true)
  })
  it('form status is not a trial filter', () => {
    expect(parseAudienceQuery(new URLSearchParams('formStatus=none'), { trialsEnabled: false }).ok).toBe(true)
  })
  it('refuses unknown keys, bad PIN prefixes, bad ages and an inverted age range', () => {
    for (const q of ['phone=98', 'pinCodePrefix=56', 'pinCodePrefix=5600001', 'pinCodePrefix=56a', 'ageMin=abc', 'ageMin=130', 'ageMin=70&ageMax=60', 'followUpDue=later']) {
      expect(parseAudienceQuery(new URLSearchParams(q), { trialsEnabled: true }), q).toEqual({ ok: false, code: 'invalid_filters' })
    }
    expect(validateAudienceFilters({ departmentId: '3' }, { trialsEnabled: true })).toEqual({ ok: false, code: 'invalid_filters' })
  })
})

describe('broadcastOutcome', () => {
  it('sent if any channel sent; failed if a channel failed or was only logged; else skipped', () => {
    expect(broadcastOutcome([{ status: 'failed' }, { status: 'sent' }])).toBe('sent')
    expect(broadcastOutcome([{ status: 'skipped' }, { status: 'failed' }])).toBe('failed')
    expect(broadcastOutcome([{ status: 'log_only' }])).toBe('failed')
    expect(broadcastOutcome([{ status: 'skipped' }, { status: 'skipped' }])).toBe('skipped')
  })
})

describe('describeAudienceFilters', () => {
  it('summarises filters with names, never ids; trial phrases only when trials are on', () => {
    const f = { departmentId: 4, ageMin: 60, ageMax: 120, pinCodePrefix: '560', trialId: 'nct1' }
    expect(describeAudienceFilters(f, { department: 'Cardiology', trial: 'Asthma' }, { trialsEnabled: false }))
      .toEqual(['Department: Cardiology (last 12 months)', 'Age 60–120', 'PIN code starts with 560'])
    expect(describeAudienceFilters({}, {}, { trialsEnabled: true })).toEqual(['All patients'])
  })
})

// --- DB-backed: the filter query -------------------------------------------------------------
const P = `WS7B-${process.pid}`
const today = todayIsoIn()
const yearsAgo = (n: number, dayShift = 0) => {
  const [y, m, d] = today.split('-').map(Number)
  const dt = new Date(Date.UTC(y - n, m - 1, d + dayShift))
  return dt.toISOString().slice(0, 10)
}
const ids = {
  match: `${P}-A`, youngSamePin: `${P}-B`, oldOtherPin: `${P}-C`, optedOut: `${P}-D`, noPhone: `${P}-E`, badPhone: `${P}-F`, smsOff: `${P}-G`, exactly60: `${P}-H`, almost60: `${P}-I`,
}
const PIN = '560987'

beforeAll(async () => {
  await getDb().insert(patients).values([
    { id: ids.match, name: 'Audience Match', dob: yearsAgo(70), pinCode: PIN, phone: '98765 43210' },
    { id: ids.youngSamePin, name: 'Audience Young', dob: yearsAgo(40), pinCode: PIN, phone: '9876543211' },
    { id: ids.oldOtherPin, name: 'Audience Other Pin', dob: yearsAgo(70), pinCode: '400001', phone: '9876543212' },
    { id: ids.optedOut, name: 'Audience Opted Out', dob: yearsAgo(75), pinCode: PIN, phone: '9876543213', notificationOptOut: true },
    { id: ids.noPhone, name: 'Audience No Phone', dob: yearsAgo(80), pinCode: PIN, phone: null },
    { id: ids.badPhone, name: 'Audience Bad Phone', dob: yearsAgo(65), pinCode: PIN, phone: '12345' },
    { id: ids.smsOff, name: 'Audience SMS Off', dob: yearsAgo(66), pinCode: PIN, phone: '9876543214' },
    { id: ids.exactly60, name: 'Audience Sixty', dob: yearsAgo(60), pinCode: PIN, phone: '9876543215' },
    { id: ids.almost60, name: 'Audience Almost Sixty', dob: yearsAgo(60, 1), pinCode: PIN, phone: '9876543216' },
  ])
  await getDb().insert(patientNotificationPreferences).values({ patientId: ids.smsOff, sms: false })
})

const allIds = Object.values(ids)
afterAll(async () => {
  await getDb().delete(notificationLog).where(inArray(notificationLog.patientId, allIds))
  await getDb().delete(patientNotificationPreferences).where(inArray(patientNotificationPreferences.patientId, allIds))
  await getDb().delete(patients).where(inArray(patients.id, allIds))
})

describe('listBroadcastRecipientCandidates (hospital filters)', () => {
  it('age 60–120 + PIN prefix 560 selects only matching patients, classifying opt-outs and missing phones', async () => {
    const members = await listBroadcastRecipientCandidates({ ageMin: 60, ageMax: 120, pinCodePrefix: '560' })
    const mine = new Map(members.filter((m) => m.id.startsWith(P)).map((m) => [m.id, m.recipientClass]))
    expect(Object.fromEntries(mine)).toEqual({
      [ids.match]: 'send', [ids.optedOut]: 'opted_out', [ids.noPhone]: 'no_phone', [ids.badPhone]: 'no_phone', [ids.smsOff]: 'opted_out', [ids.exactly60]: 'send',
    })
    // Every other patient returned also satisfies the filters.
    const others = members.filter((m) => !m.id.startsWith(P)).map((m) => m.id)
    if (others.length > 0) {
      const rows = await getDb().select({ dob: patients.dob, pin: patients.pinCode }).from(patients).where(inArray(patients.id, others))
      for (const r of rows) {
        expect(r.pin?.startsWith('560')).toBe(true)
        expect(r.dob <= yearsAgo(60)).toBe(true)
      }
    }
    expect(summariseAudience([...mine.values()])).toEqual({ match: 6, optedOut: 2, noPhone: 2, sendable: 2 })
  })

  it('a maximum age excludes older patients', async () => {
    const members = await listBroadcastRecipientCandidates({ ageMax: 69, pinCodePrefix: PIN })
    expect(members.map((m) => m.id).sort()).toEqual([ids.almost60, ids.badPhone, ids.exactly60, ids.smsOff, ids.youngSamePin].sort())
  })
})

describe('sendBroadcast', () => {
  it('sends broadcast_notice to sendable recipients only and stores sent/skipped/failed', async () => {
    const adapter = (name: 'sms' | 'whatsapp' | 'email' | 'in_app', ok: boolean): ChannelAdapter => ({ name, configured: () => true, send: async () => (ok ? { ok: true, providerMessageId: 'x' } : { ok: false, errorClass: 'http_500' }) })
    const registry: ChannelRegistry = { sms: adapter('sms', true), whatsapp: adapter('whatsapp', false), email: adapter('email', false), in_app: adapter('in_app', false) }
    const audience = await listBroadcastRecipientCandidates({ pinCodePrefix: PIN, ageMin: 60 })
    const r = await sendBroadcast({ message: 'Free eye camp on Sunday at the hospital.', filters: { pinCodePrefix: PIN, ageMin: 60 }, hospitalName: 'City Hospital', sentBy: 'Test', audience }, { registry })
    try {
      expect(r).toMatchObject({ recipientCount: 6, sentCount: 2, skippedCount: 4, failedCount: 0 })
      const [row] = await getDb().select().from(broadcasts).where(eq(broadcasts.id, r.id))
      expect(row).toMatchObject({ templateKey: 'broadcast_notice', sentCount: 2, skippedCount: 4, failedCount: 0, filters: { pinCodePrefix: PIN, ageMin: 60 } })
      const log = await getDb().select().from(notificationLog).where(eq(notificationLog.dedupeKey, `broadcast:${r.id}`))
      expect(new Set(log.map((l) => l.patientId))).toEqual(new Set([ids.match, ids.exactly60]))
      expect(log.every((l) => l.templateKey === 'broadcast_notice')).toBe(true)
    } finally {
      await getDb().delete(broadcasts).where(eq(broadcasts.id, r.id))
    }
  })
})

describe('sendBroadcast duplicate guard', () => {
  const quiet: ChannelRegistry = (() => {
    const a = (name: 'sms' | 'whatsapp' | 'email' | 'in_app'): ChannelAdapter => ({ name, configured: () => true, send: async () => ({ ok: true, providerMessageId: 'x' }) })
    return { sms: a('sms'), whatsapp: a('whatsapp'), email: a('email'), in_app: a('in_app') }
  })()
  const created: number[] = []
  afterAll(async () => {
    if (created.length) await getDb().delete(broadcasts).where(inArray(broadcasts.id, created))
  })

  it('refuses an identical message + filters from the same sender within 10 minutes, sending nothing', async () => {
    const audience = await listBroadcastRecipientCandidates({ pinCodePrefix: PIN, ageMin: 60 })
    const sender = `Dup Sender ${P}`
    const input = { message: 'OPD closed on Monday for maintenance.', filters: { pinCodePrefix: PIN, ageMin: 60 }, hospitalName: 'City Hospital', sentBy: sender, audience }
    const first = await sendBroadcast(input, { registry: quiet })
    created.push(first.id)
    const logBefore = await getDb().select({ id: notificationLog.id }).from(notificationLog).where(inArray(notificationLog.patientId, allIds))

    // Same filters in a different key order are the same audience.
    await expect(sendBroadcast({ ...input, filters: { ageMin: 60, pinCodePrefix: PIN } }, { registry: quiet })).rejects.toBeInstanceOf(DuplicateBroadcastError)
    const rows = await getDb().select({ id: broadcasts.id }).from(broadcasts).where(eq(broadcasts.sentBy, sender))
    expect(rows.map((r) => r.id)).toEqual([first.id])
    const logAfter = await getDb().select({ id: notificationLog.id }).from(notificationLog).where(inArray(notificationLog.patientId, allIds))
    expect(logAfter.length).toBe(logBefore.length)

    // Two concurrent submits: exactly one goes through.
    const msg2 = 'Blood donation camp on Saturday.'
    const results = await Promise.allSettled([sendBroadcast({ ...input, message: msg2 }, { registry: quiet }), sendBroadcast({ ...input, message: msg2 }, { registry: quiet })])
    for (const r of results) if (r.status === 'fulfilled') created.push(r.value.id)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected' && r.reason instanceof DuplicateBroadcastError)).toHaveLength(1)

    // A different message, different filters, another sender, or an older broadcast are not duplicates.
    const other = await sendBroadcast({ ...input, filters: { pinCodePrefix: PIN, ageMin: 61 } }, { registry: quiet })
    created.push(other.id)
    const another = await sendBroadcast({ ...input, sentBy: `${sender} 2` }, { registry: quiet })
    created.push(another.id)
    await getDb().execute(sql`UPDATE broadcasts SET sent_at = now() - interval '11 minutes' WHERE id = ${first.id}`)
    const later = await sendBroadcast(input, { registry: quiet })
    created.push(later.id)
  })
})

// --- DB-backed: department, doctor, ward and follow-up filters ------------------------------
describe('listBroadcastRecipientCandidates (encounter, ward and follow-up filters)', () => {
  const Q = `WS7BF-${process.pid}`
  const pid = {
    deptRecent: `${Q}-A`, deptOld: `${Q}-B`, deptCancelled: `${Q}-C`, otherDept: `${Q}-D`,
    wardAdmitted: `${Q}-E`, wardDischarged: `${Q}-F`, otherWard: `${Q}-G`,
    fuOverdue: `${Q}-H`, fuLongOverdue: `${Q}-I`, fuDue7: `${Q}-J`, fuLater: `${Q}-K`, fuScheduled: `${Q}-L`,
  }
  const pids = Object.values(pid)
  const WARD = `WS7B Ward ${process.pid}`
  const OTHER_WARD = `WS7B Other Ward ${process.pid}`
  let deptId = 0
  let otherDeptId = 0
  let docId = 0
  let otherDocId = 0
  const monthsAgo = (n: number) => {
    const [y, m, d] = today.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1 - n, d)).toISOString().slice(0, 10)
  }
  const mine = async (f: Parameters<typeof listBroadcastRecipientCandidates>[0]) =>
    (await listBroadcastRecipientCandidates(f)).map((m) => m.id).filter((id) => id.startsWith(Q)).sort()

  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values(pids.map((id) => ({ id, name: `Filter ${id.slice(-1)}`, dob: '1970-01-01', phone: '9876500000' })))
    const tag = String(process.pid).slice(-6)
    const [d1, d2] = await db.insert(departments).values([{ code: `WSA${tag}`, name: `WS7B Dept ${tag}` }, { code: `WSB${tag}`, name: `WS7B Dept2 ${tag}` }]).returning({ id: departments.id })
    deptId = d1.id
    otherDeptId = d2.id
    const [p1, p2] = await db.insert(providers).values([
      { name: `WS7B Doctor ${tag}`, specialty: 'General Medicine', colorTag: 'blue' },
      { name: `WS7B Doctor2 ${tag}`, specialty: 'General Medicine', colorTag: 'green' },
    ]).returning({ id: providers.id })
    docId = p1.id
    otherDocId = p2.id
    const enc = (patientId: string, date: string, extra: Partial<typeof encounters.$inferInsert> = {}) =>
      ({ patientId, encounterType: 'opd' as const, encounterDate: date, departmentId: deptId, providerId: docId, checkedInByName: 'Test', status: 'completed' as const, ...extra })
    await db.insert(encounters).values([
      enc(pid.deptRecent, monthsAgo(11)),
      enc(pid.deptOld, monthsAgo(13)),
      enc(pid.deptCancelled, addDaysIso(today, -10), { status: 'cancelled', cancelReason: 'Patient did not come' }),
      enc(pid.otherDept, addDaysIso(today, -10), { departmentId: otherDeptId, providerId: otherDocId }),
    ])
    const [r1, r2] = await db.insert(rooms).values([
      { ward: WARD, roomNumber: '1', bedNumber: 'A' },
      { ward: OTHER_WARD, roomNumber: '1', bedNumber: 'A' },
    ]).returning({ id: rooms.id })
    await db.insert(admissions).values([
      { patientId: pid.wardAdmitted, currentRoomId: r1.id, attendingProviderId: docId, status: 'admitted' },
      { patientId: pid.wardDischarged, currentRoomId: r1.id, attendingProviderId: docId, status: 'discharged', dischargedAt: new Date() },
      { patientId: pid.otherWard, currentRoomId: r2.id, attendingProviderId: docId, status: 'admitted' },
    ])
    const fu = (patientId: string, due: number, start: number, end: number, status: 'planned' | 'scheduled' = 'planned') => ({
      patientId, source: 'manual' as const, status, prescribedByProviderId: docId, baseDate: addDaysIso(today, -30),
      dueDate: addDaysIso(today, due), windowStart: addDaysIso(today, start), windowEnd: addDaysIso(today, end), reason: 'Review', createdByName: 'Test',
    })
    await db.insert(followUpOrders).values([
      fu(pid.fuOverdue, -5, -7, -3),
      fu(pid.fuLongOverdue, -25, -27, -20),
      fu(pid.fuDue7, 3, 0, 10),
      fu(pid.fuLater, 20, 15, 25),
      fu(pid.fuScheduled, 3, 0, 10, 'scheduled'),
    ])
  })

  afterAll(async () => {
    const db = getDb()
    await db.delete(followUpOrders).where(inArray(followUpOrders.patientId, pids))
    await db.delete(admissions).where(inArray(admissions.patientId, pids))
    await db.delete(rooms).where(inArray(rooms.ward, [WARD, OTHER_WARD]))
    await db.delete(encounters).where(inArray(encounters.patientId, pids))
    await db.delete(providers).where(inArray(providers.id, [docId, otherDocId]))
    await db.delete(departments).where(inArray(departments.id, [deptId, otherDeptId]))
    await db.delete(patients).where(inArray(patients.id, pids))
  })

  it('department: an encounter in the last 12 months counts; older, cancelled or another department do not', async () => {
    expect(await mine({ departmentId: deptId })).toEqual([pid.deptRecent])
    expect(await mine({ departmentId: otherDeptId })).toEqual([pid.otherDept])
  })

  it('doctor: the same 12-month, not-cancelled rule', async () => {
    expect(await mine({ providerId: docId })).toEqual([pid.deptRecent])
    expect(await mine({ providerId: otherDocId })).toEqual([pid.otherDept])
  })

  it('ward: only patients currently admitted to a bed in that ward', async () => {
    expect(await mine({ ward: WARD })).toEqual([pid.wardAdmitted])
    expect(await mine({ ward: OTHER_WARD })).toEqual([pid.otherWard])
  })

  it('follow-up: overdue inside the grace period, or due within 7 days; booked ones and later ones are out', async () => {
    expect(await mine({ followUpDue: 'overdue' })).toEqual([pid.fuOverdue])
    expect(await mine({ followUpDue: 'due_7_days' })).toEqual([pid.fuDue7])
  })
})
