import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { POST as decline } from '@/app/api/front-desk/assignments/[id]/decline/route'
import { getDb } from '@/db/client'
import { doctorAssignments, appointments, messages } from '@/db/schema'
import { createDoctorAssignment, scheduleAssignment, declineAssignment } from '@/lib/queries/doctor-assignments'
import { listActiveProviders } from '@/lib/queries/providers'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

// Pass-through spy: the route resolves the provider AFTER reading the
// assignment's status, so the race test can schedule the row in between.
vi.mock('@/lib/doctor-queue-provider', async () => {
  const a = await vi.importActual<typeof import('@/lib/doctor-queue-provider')>('@/lib/doctor-queue-provider')
  return { resolveDoctorQueueProvider: vi.fn(a.resolveDoctorQueueProvider) }
})

vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: 'pi', name: 'Dr. R. Kunam' })) }))

async function providerId(match: (name: string) => boolean): Promise<number> {
  const p = (await listActiveProviders()).find((x) => match(x.name))
  if (!p) throw new Error('Seeded provider not found -- run npm run db:seed')
  return p.id
}
const kunamProviderId = () => providerId((n) => n.includes('Kunam'))
const otherProviderId = () => providerId((n) => !n.includes('Kunam'))

const assignmentIds: number[] = []
const appointmentIds: number[] = []

async function newAssignment(pid?: number) {
  const providerIdVal = pid ?? (await kunamProviderId())
  const a = await createDoctorAssignment({ patientId: 'RD-0001', providerId: providerIdVal, visitType: 'outpatient', urgency: 'routine', reason: 'Test', roomId: null, assignedByName: 'Taylor Nguyen' })
  assignmentIds.push(a.id)
  return a
}
async function getRow(id: number) {
  const [row] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, id))
  return row
}
function post(id: number, reason = 'Fully booked') {
  const req = new Request('http://localhost', { method: 'POST', body: JSON.stringify({ reason }) })
  return decline(req as never, { params: Promise.resolve({ id: String(id) }) })
}
async function messageCount() {
  return (await getDb().select({ id: messages.id }).from(messages).where(eq(messages.patientId, 'RD-0001'))).length
}

afterEach(async () => {
  while (assignmentIds.length > 0) await getDb().delete(doctorAssignments).where(eq(doctorAssignments.id, assignmentIds.pop()!))
  if (appointmentIds.length > 0) await getDb().delete(appointments).where(inArray(appointments.id, appointmentIds.splice(0)))
})

const CONFLICT = { error: 'This assignment has already been scheduled or declined.' }

describe('POST /api/front-desk/assignments/[id]/decline -- status guard', () => {
  it('declining a pending assignment succeeds and sends no message', async () => {
    const a = await newAssignment()
    const before = await messageCount()
    const res = await post(a.id, 'Fully booked this week')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('declined')
    expect(body.declineReason).toBe('Fully booked this week')
    expect(await messageCount()).toBe(before)
  })

  it('declining a scheduled assignment -> 409 and leaves status/appointmentId/appointment untouched', async () => {
    const a = await newAssignment()
    const [appt] = await getDb().insert(appointments).values({
      patientId: 'RD-0001', providerId: a.providerId,
      startsAt: new Date('2026-12-01T09:00:00'), endsAt: new Date('2026-12-01T09:30:00'),
      visitReason: 'Follow-up', status: 'scheduled',
    }).returning()
    appointmentIds.push(appt.id)
    await scheduleAssignment(a.id, appt.id)

    const res = await post(a.id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(CONFLICT)

    const row = await getRow(a.id)
    expect(row.status).toBe('scheduled')
    expect(row.appointmentId).toBe(appt.id)
    expect(row.declineReason).toBeNull()
    const [after] = await getDb().select().from(appointments).where(eq(appointments.id, appt.id))
    expect(after.status).toBe('scheduled')
  })

  it('declining an already-declined assignment -> 409, reason unchanged', async () => {
    const a = await newAssignment()
    await declineAssignment(a.id, 'First reason')
    const res = await post(a.id, 'Second reason')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(CONFLICT)
    const row = await getRow(a.id)
    expect(row.status).toBe('declined')
    expect(row.declineReason).toBe('First reason')
  })

  it('a schedule that commits after the route read the row as pending -> 409, row stays scheduled', async () => {
    const a = await newAssignment()
    const actual = (await vi.importActual<typeof import('@/lib/doctor-queue-provider')>('@/lib/doctor-queue-provider')).resolveDoctorQueueProvider
    let apptId: number | null = null
    vi.mocked(resolveDoctorQueueProvider).mockImplementationOnce(async (session) => {
      // The route has already read status 'pending'; a concurrent schedule commits now.
      const [appt] = await getDb().insert(appointments).values({
        patientId: 'RD-0001', providerId: a.providerId,
        startsAt: new Date('2026-12-02T09:00:00'), endsAt: new Date('2026-12-02T09:30:00'),
        visitReason: 'Follow-up', status: 'scheduled',
      }).returning()
      appointmentIds.push(appt.id)
      apptId = appt.id
      await scheduleAssignment(a.id, appt.id)
      return actual(session)
    })

    const res = await post(a.id, 'Too late')
    expect(apptId).not.toBeNull()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(CONFLICT)
    const row = await getRow(a.id)
    expect(row.status).toBe('scheduled')
    expect(row.appointmentId).toBe(apptId)
    expect(row.declineReason).toBeNull()
  })

  it('still returns 403 for a different provider\'s assignment', async () => {
    const a = await newAssignment(await otherProviderId())
    const res = await post(a.id)
    expect(res.status).toBe(403)
    expect((await getRow(a.id)).status).toBe('pending')
  })
})

describe('POST /api/front-desk/assignments/[id]/decline -- empty session name', () => {
  it.each(['', '   '])('pi named %j -> 403, assignment stays pending', async (name) => {
    const auth = await import('@/lib/auth')
    vi.mocked(auth.requireSession).mockResolvedValueOnce({ role: 'pi', name, userId: null })
    // The provider the old includes('') fallback would have matched.
    const a = await newAssignment((await listActiveProviders())[0].id)
    const before = await messageCount()
    const res = await post(a.id)
    expect(res.status).toBe(403)
    const row = await getRow(a.id)
    expect(row.status).toBe('pending')
    expect(row.declineReason).toBeNull()
    expect(row.appointmentId).toBeNull()
    expect(await messageCount()).toBe(before)
  })
})
