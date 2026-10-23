import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import pg from 'pg'
import { eq } from 'drizzle-orm'
import type { Role } from '@/lib/auth'
import { getDb } from '@/db/client'
import { appointments, patients, providerLeave, providerSchedules, providers } from '@/db/schema'
import { todayIsoIn } from '@/lib/india-time'
import { ALL_ROLES, MASTER_DATA_ADMIN_ROLES, SCHEDULING_ROLES } from '@/lib/role-policy'

let sessionRole: Role = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Probe', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { logAudit } from '@/lib/audit'
import { GET as getSchedule, PUT as putSchedule } from '@/app/api/providers/[id]/schedule/route'
import { GET as getSlots } from '@/app/api/providers/[id]/slots/route'
import { getProviderScheduleForDate } from '@/lib/queries/provider-schedules'
import { readMigration, idempotencyProblems, missingColumns } from '../db/migration-sql'

const DAY_MS = 24 * 60 * 60 * 1000
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
/** The first date on or after `from` that falls on `weekday`. */
const nextWeekday = (from: string, weekday: number) => addDays(from, (weekday - weekdayOf(from) + 7) % 7)

const TODAY = todayIsoIn()
const MONDAY = nextWeekday(addDays(TODAY, 1), 1)

let providerId = 0
let patientId = ''
const createdAppointments: number[] = []

const put = (body: unknown, id = String(providerId)) =>
  putSchedule(new NextRequest(`http://localhost/api/providers/${id}/schedule`, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const getSched = (id = String(providerId)) =>
  getSchedule(new NextRequest(`http://localhost/api/providers/${id}/schedule`), { params: Promise.resolve({ id }) })
const slots = (date: string, id = String(providerId)) =>
  getSlots(new NextRequest(`http://localhost/api/providers/${id}/slots?date=${date}`), { params: Promise.resolve({ id }) })

const VALID = {
  slotMinutes: 15,
  sessions: [
    { weekday: 1, start: '09:00', end: '13:00' },
    { weekday: 1, start: '17:00', end: '19:00' },
    { weekday: 3, start: '10:00', end: '12:00' },
  ],
  leave: [{ date: addDays(MONDAY, 7), reason: 'Conference in Pune' }],
}

beforeAll(async () => {
  const [p] = await getDb().insert(providers).values({ name: 'Schedule Probe', specialty: 'General Medicine', colorTag: 'chart-1' }).returning({ id: providers.id })
  providerId = p.id
  const [pt] = await getDb().select({ id: patients.id }).from(patients).limit(1)
  patientId = pt.id
})

afterAll(async () => {
  const db = getDb()
  for (const id of createdAppointments) await db.delete(appointments).where(eq(appointments.id, id))
  await db.delete(providerSchedules).where(eq(providerSchedules.providerId, providerId))
  await db.delete(providerLeave).where(eq(providerLeave.providerId, providerId))
  await db.delete(providers).where(eq(providers.id, providerId))
})

beforeEach(() => {
  sessionRole = 'admin'
  vi.mocked(logAudit).mockClear()
})

describe('PUT /api/providers/[id]/schedule', () => {
  it('denies every role outside MASTER_DATA_ADMIN_ROLES (frontdesk included) before reading the body', async () => {
    for (const role of ALL_ROLES.filter((r) => !MASTER_DATA_ADMIN_ROLES.includes(r))) {
      sessionRole = role
      const res = await put('{not json')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    sessionRole = 'frontdesk'
    expect((await put(VALID)).status).toBe(403)
  })

  it('400s overlapping sessions within a weekday', async () => {
    const res = await put({ ...VALID, sessions: [{ weekday: 1, start: '09:00', end: '13:00' }, { weekday: 1, start: '12:30', end: '14:00' }] })
    expect(res.status).toBe(400)
  })

  it('400s a slot length that is not a multiple of 5 or outside 5..60', async () => {
    expect((await put({ ...VALID, slotMinutes: 7 })).status).toBe(400)
    expect((await put({ ...VALID, slotMinutes: 0 })).status).toBe(400)
    expect((await put({ ...VALID, slotMinutes: 65 })).status).toBe(400)
  })

  it('400s an end not after start, a bad time, unknown keys, a past or doubled leave date', async () => {
    expect((await put({ ...VALID, sessions: [{ weekday: 1, start: '10:00', end: '10:00' }] })).status).toBe(400)
    expect((await put({ ...VALID, sessions: [{ weekday: 1, start: '9:00', end: '10:00' }] })).status).toBe(400)
    expect((await put({ ...VALID, sessions: [{ weekday: 7, start: '09:00', end: '10:00' }] })).status).toBe(400)
    expect((await put({ ...VALID, extra: true })).status).toBe(400)
    expect((await put({ ...VALID, leave: [{ date: addDays(TODAY, -1), reason: 'Old' }] })).status).toBe(400)
    expect((await put({ ...VALID, leave: [{ date: MONDAY, reason: 'A' }, { date: MONDAY, reason: 'B' }] })).status).toBe(400)
    expect((await put({ ...VALID, leave: [{ date: MONDAY, reason: '' }] })).status).toBe(400)
    expect((await put({ ...VALID, leave: [{ date: '2099-02-30', reason: 'X' }] })).status).toBe(400)
  })

  it('404s an unknown provider and 400s a bad id', async () => {
    expect((await put(VALID, '2147483000')).status).toBe(404)
    expect((await put(VALID, 'abc')).status).toBe(400)
  })

  it('replaces sessions and future leave, keeps past leave, and audits without the leave reason', async () => {
    const past = addDays(TODAY, -3)
    await getDb().insert(providerLeave).values({ providerId, leaveDate: past, reason: 'Past leave' })
    expect((await put({ ...VALID, leave: [{ date: addDays(MONDAY, 14), reason: 'Will be replaced' }] })).status).toBe(200)

    const res = await put(VALID)
    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenLastCalledWith(expect.anything(), 'updated provider schedule', null, expect.any(String))
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls)).not.toContain('Pune')

    const body = await (await getSched()).json()
    expect(body.slotMinutes).toBe(15)
    expect(body.opdRoom).toBeNull()
    expect(body.sessions).toEqual(VALID.sessions)
    expect(body.leave).toEqual(VALID.leave)

    const leaveRows = await getDb().select().from(providerLeave).where(eq(providerLeave.providerId, providerId))
    expect(leaveRows.map((r) => r.leaveDate).sort()).toEqual([past, VALID.leave[0].date].sort())
  })
})

describe('GET /api/providers/[id]/schedule', () => {
  it('is open to SCHEDULING_ROLES only', async () => {
    for (const role of ALL_ROLES) {
      sessionRole = role
      const res = await getSched()
      expect(res.status).toBe(SCHEDULING_ROLES.includes(role) ? 200 : 403)
    }
  })
  it('404s an unknown provider', async () => {
    expect((await getSched('2147483000')).status).toBe(404)
  })
})

describe('GET /api/providers/[id]/slots', () => {
  beforeAll(async () => {
    sessionRole = 'admin'
    await put({ ...VALID, slotMinutes: 15 })
  })

  it('computes Monday’s slots, marking a booked one', async () => {
    const [a] = await getDb().insert(appointments).values({
      patientId, providerId, visitReason: 'Fever',
      startsAt: new Date(`${MONDAY}T09:30:00+05:30`), endsAt: new Date(`${MONDAY}T09:45:00+05:30`),
    }).returning({ id: appointments.id })
    createdAppointments.push(a.id)
    const [c] = await getDb().insert(appointments).values({
      patientId, providerId, visitReason: 'Cancelled', status: 'cancelled',
      startsAt: new Date(`${MONDAY}T10:00:00+05:30`), endsAt: new Date(`${MONDAY}T10:15:00+05:30`),
    }).returning({ id: appointments.id })
    createdAppointments.push(c.id)

    sessionRole = 'frontdesk'
    const res = await slots(MONDAY)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ date: MONDAY, slotMinutes: 15, onLeave: false })
    expect(body.slots).toHaveLength(16 + 8)
    expect(body.slots[0]).toEqual({ startsAt: new Date(`${MONDAY}T09:00:00+05:30`).toISOString(), endsAt: new Date(`${MONDAY}T09:15:00+05:30`).toISOString(), status: 'free' })
    const booked = body.slots.filter((s: { status: string }) => s.status === 'booked')
    expect(booked.map((s: { startsAt: string }) => s.startsAt)).toEqual([new Date(`${MONDAY}T09:30:00+05:30`).toISOString()])
  })

  it('returns no slots with onLeave on a leave day', async () => {
    const body = await (await slots(VALID.leave[0].date)).json()
    expect(body).toEqual({ date: VALID.leave[0].date, slotMinutes: 15, onLeave: true, slots: [] })
  })

  it('400s a malformed date or one more than 90 days ahead; 404s an unknown provider; 403s a non-scheduling role', async () => {
    expect((await slots('2026-13-01')).status).toBe(400)
    expect((await slots('tomorrow')).status).toBe(400)
    expect((await slots(addDays(TODAY, 91))).status).toBe(400)
    expect((await slots(addDays(TODAY, 90))).status).toBe(200)
    expect((await slots(MONDAY, '2147483000')).status).toBe(404)
    sessionRole = ALL_ROLES.find((r) => !SCHEDULING_ROLES.includes(r))!
    expect((await slots(MONDAY)).status).toBe(403)
  })
})

describe('getProviderScheduleForDate', () => {
  it('returns slot length, that weekday’s sessions and the leave flag; null for an unknown provider', async () => {
    expect(await getProviderScheduleForDate(providerId, MONDAY)).toEqual({
      slotMinutes: 15, onLeave: false, sessions: VALID.sessions.filter((s) => s.weekday === 1),
    })
    expect(await getProviderScheduleForDate(providerId, VALID.leave[0].date)).toMatchObject({ onLeave: true })
    expect(await getProviderScheduleForDate(2147483000, MONDAY)).toBeNull()
  })
})

describe('WS6 T6 migration (provider schedules)', () => {
  const MIGRATION = '2026-10-25-ws6-provider-schedules.sql'
  const body = () => readMigration(MIGRATION).replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')

  it('is idempotent and declares every column', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    expect(missingColumns(providerSchedules, s)).toEqual([])
    expect(missingColumns(providerLeave, s)).toEqual([])
    for (const col of ['slot_minutes', 'opd_room', 'portal_bookable']) expect(s).toContain(col)
  })

  it('makes doctors in non-clinical departments not portal-bookable only when it adds the column', async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await c.connect()
    try {
      await c.query('BEGIN')
      const code = `WS6P${Date.now() % 100000}`
      const dept = await c.query(`INSERT INTO departments (code, name, kind) VALUES ($1, 'Pathology probe', 'diagnostic') RETURNING id`, [code])
      const clinical = await c.query(`INSERT INTO departments (code, name, kind) VALUES ($1, 'Medicine probe', 'clinical') RETURNING id`, [`${code}C`])
      const path = await c.query(`INSERT INTO providers (name, specialty, color_tag, department_id) VALUES ('Path probe', 'Pathology', 'chart-2', $1) RETURNING id`, [dept.rows[0].id])
      const gp = await c.query(`INSERT INTO providers (name, specialty, color_tag, department_id) VALUES ('GP probe', 'General Medicine', 'chart-3', $1) RETURNING id`, [clinical.rows[0].id])
      const bookable = async (id: number) => (await c.query('SELECT portal_bookable FROM providers WHERE id = $1', [id])).rows[0].portal_bookable

      await c.query('ALTER TABLE providers DROP COLUMN portal_bookable')
      await c.query(body())
      expect(await bookable(path.rows[0].id)).toBe(false)
      expect(await bookable(gp.rows[0].id)).toBe(true)

      // An admin later offers the pathologist online; a re-run must not undo it.
      await c.query('UPDATE providers SET portal_bookable = true WHERE id = $1', [path.rows[0].id])
      await c.query(body())
      expect(await bookable(path.rows[0].id)).toBe(true)
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      await c.end()
    }
  })
})
