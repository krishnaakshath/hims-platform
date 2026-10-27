import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { inArray } from 'drizzle-orm'
import type { Role } from '@/lib/auth'
import { getDb } from '@/db/client'
import { departments, encounters, patients, providerLeave, providerSchedules, providers } from '@/db/schema'
import { todayIsoIn } from '@/lib/india-time'
import { istWeekdayOf } from '@/lib/scheduling/slots'
import { ALL_ROLES, CHECK_IN_ROLES } from '@/lib/role-policy'

let sessionRole: Role = 'frontdesk'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Queue Probe', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

import { logAudit } from '@/lib/audit'
import { GET } from '@/app/api/front-desk/queue-summary/route'

// WS6 T9 (spec D6): the check-in dialog's queue length per clinical doctor, from today's (IST)
// OPD encounters, with on-leave / outside-hours availability.
const DAY_MS = 24 * 60 * 60 * 1000
const TODAY = todayIsoIn()
const YESTERDAY = new Date(Date.parse(`${TODAY}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
const SUFFIX = String(Date.now() % 100000)

const ids = { gm: 0, path: 0, free: 0, leave: 0, closed: 0, pathologist: 0 }
let patientId = ''

type Row = { providerId: number; departmentId: number | null; waiting: number; inConsultation: number; estimatedWaitMinutes: number | null; availability: string }
async function summary(): Promise<Row[]> {
  const res = await GET()
  expect(res.status).toBe(200)
  return (await res.json()).providers
}

beforeAll(async () => {
  const db = getDb()
  const [gm] = await db.insert(departments).values({ code: `QGM${SUFFIX}`, name: `Queue General Medicine ${SUFFIX}`, kind: 'clinical' }).returning({ id: departments.id })
  const [path] = await db.insert(departments).values({ code: `QPA${SUFFIX}`, name: `Queue Pathology ${SUFFIX}`, kind: 'diagnostic' }).returning({ id: departments.id })
  ids.gm = gm.id
  ids.path = path.id
  const mk = async (name: string, departmentId: number, slotMinutes = 10) => {
    const [p] = await db.insert(providers).values({ name, specialty: 'General Medicine', colorTag: 'chart-1', departmentId, slotMinutes }).returning({ id: providers.id })
    return p.id
  }
  ids.free = await mk('Dr Queue Free', gm.id)
  ids.leave = await mk('Dr Queue Leave', gm.id)
  ids.closed = await mk('Dr Queue Closed', gm.id)
  ids.pathologist = await mk('Dr Queue Pathologist', path.id)

  await db.insert(providerLeave).values({ providerId: ids.leave, leaveDate: TODAY, reason: 'Family function' })
  // A session today that does not contain the current IST minute.
  const nowMinute = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(':', '')) // HHMM
  const session = nowMinute >= 100 ? { startTime: '00:00', endTime: '00:30' } : { startTime: '23:00', endTime: '23:59' }
  await db.insert(providerSchedules).values({ providerId: ids.closed, weekday: istWeekdayOf(TODAY), ...session })

  const [pt] = await db.select({ id: patients.id }).from(patients).limit(1)
  patientId = pt.id
  const enc = (providerId: number, status: 'checked_in' | 'in_consultation' | 'completed' | 'cancelled', encounterDate = TODAY, encounterType: 'opd' | 'ipd' = 'opd') =>
    ({ patientId, providerId, status, encounterDate, encounterType, checkedInByName: 'Queue Probe' })
  await db.insert(encounters).values([
    enc(ids.free, 'checked_in'),
    enc(ids.free, 'checked_in'),
    enc(ids.free, 'checked_in'),
    enc(ids.free, 'in_consultation'),
    enc(ids.free, 'completed'),
    enc(ids.free, 'cancelled'),
    enc(ids.free, 'checked_in', YESTERDAY),
    enc(ids.free, 'checked_in', TODAY, 'ipd'),
    enc(ids.leave, 'checked_in'),
    enc(ids.pathologist, 'checked_in'),
  ])
})

afterAll(async () => {
  const db = getDb()
  const all = [ids.free, ids.leave, ids.closed, ids.pathologist]
  await db.delete(encounters).where(inArray(encounters.providerId, all))
  await db.delete(providerSchedules).where(inArray(providerSchedules.providerId, all))
  await db.delete(providerLeave).where(inArray(providerLeave.providerId, all))
  await db.delete(providers).where(inArray(providers.id, all))
  await db.delete(departments).where(inArray(departments.id, [ids.gm, ids.path]))
})

beforeEach(() => {
  sessionRole = 'frontdesk'
  vi.mocked(logAudit).mockClear()
})

describe('GET /api/front-desk/queue-summary', () => {
  it('denies every role outside CHECK_IN_ROLES', async () => {
    for (const role of ALL_ROLES.filter((r) => !CHECK_IN_ROLES.includes(r))) {
      sessionRole = role
      const res = await GET()
      expect(res.status).toBe(403)
    }
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('counts only today\'s OPD checked_in encounters as waiting, and in-consultation separately', async () => {
    const free = (await summary()).find((p) => p.providerId === ids.free)
    expect(free).toEqual({ providerId: ids.free, departmentId: ids.gm, waiting: 3, inConsultation: 1, estimatedWaitMinutes: 30, availability: 'available' })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }), 'viewed front desk queue summary', null, expect.stringMatching(/^count=\d+$/))
  })

  it('marks a doctor on leave today and one outside today\'s sessions', async () => {
    const rows = await summary()
    expect(rows.find((p) => p.providerId === ids.leave)).toMatchObject({ waiting: 1, availability: 'on_leave', estimatedWaitMinutes: null })
    expect(rows.find((p) => p.providerId === ids.closed)).toMatchObject({ waiting: 0, availability: 'outside_hours', estimatedWaitMinutes: null })
  })

  it('leaves out a doctor of a diagnostic department (pathologist)', async () => {
    expect((await summary()).some((p) => p.providerId === ids.pathologist)).toBe(false)
  })
})
