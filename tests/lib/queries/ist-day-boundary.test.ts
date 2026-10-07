// I5: "today" for the lobby board and the front-desk assignment list is the
// IST business day, whatever the server's own zone. The server here runs UTC.
import { vi } from 'vitest'
vi.hoisted(() => { process.env.TZ = 'UTC' })
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { doctorAssignments, patients, providers } from '@/db/schema'
import { getQueueDisplayRows } from '@/lib/queries/queue-display'
import { listTodaysAssignments } from '@/lib/queries/doctor-assignments'

const RUN = `${Date.now()}`
const PATIENT = `TEST-SP3-${RUN}-IST`
let providerId = 0
const ids: number[] = []

// 11 May 2099 IST runs from 2099-05-10T18:30Z to 2099-05-11T18:30Z.
const PREV_DAY_LATE = new Date('2099-05-10T18:00:00Z') // 23:30 IST 10 May
const TODAY_EARLY = new Date('2099-05-10T18:45:00Z') // 00:15 IST 11 May
const TODAY_LATE = new Date('2099-05-11T18:00:00Z') // 23:30 IST 11 May
const NEXT_DAY = new Date('2099-05-11T19:00:00Z') // 00:30 IST 12 May

describe.skipIf(!process.env.DATABASE_URL)('IST business day boundary (DB)', () => {
  beforeAll(async () => {
    const db = getDb()
    const [p] = await db.insert(providers).values({ name: 'TEST_SP3 Dr IST', specialty: 'Test', colorTag: '#000000' }).returning()
    providerId = p.id
    await db.insert(patients).values({ id: PATIENT, name: 'TEST_SP3 IST Patient', dob: '1990-01-01' })
    const rows = await db.insert(doctorAssignments).values([PREV_DAY_LATE, TODAY_EARLY, TODAY_LATE, NEXT_DAY].map((createdAt, i) => ({
      patientId: PATIENT, providerId, visitType: 'outpatient' as const, urgency: 'routine' as const, reason: 'TEST_SP3 ist',
      assignedByName: 'TEST_SP3 IST', queueTicketNumber: 990001 + i, createdAt,
    }))).returning({ id: doctorAssignments.id })
    ids.push(...rows.map((r) => r.id))
  })
  afterEach(() => { vi.useRealTimers() })
  afterAll(async () => {
    const db = getDb()
    await db.delete(doctorAssignments).where(inArray(doctorAssignments.id, ids))
    await db.delete(patients).where(eq(patients.id, PATIENT))
    await db.delete(providers).where(eq(providers.id, providerId))
  })

  const ours = (tickets: number[]) => tickets.filter((t) => t >= 990001 && t <= 990004).sort()
  const ourIds = (rows: { id: number }[]) => rows.map((r) => r.id).filter((id) => ids.includes(id)).sort((a, b) => a - b)

  it.each([
    ['02:00 IST', new Date('2099-05-10T20:30:00Z')],
    ['05:30 IST (UTC midnight)', new Date('2099-05-11T00:00:00Z')],
  ])('at %s the lobby board and today\'s assignments are exactly that IST day', async (_label, now) => {
    expect(new Date(0).getTimezoneOffset()).toBe(0) // the server zone really is UTC here
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    expect(ours((await getQueueDisplayRows()).map((r) => r.ticketNumber))).toEqual([990002, 990003])
    expect(ourIds(await listTodaysAssignments())).toEqual([ids[1], ids[2]])
  })
})
