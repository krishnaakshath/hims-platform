// Wave J (P1-20): staff confirmation of portal requests. A cancellation is confirmed with an
// empty body and cancels the patient's appointment (audited on the same transaction); a
// reschedule books the new slot and releases the old one; a portal request can only be
// confirmed for its own patient.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, auditLog, bookingRequests, patients, providers } from '@/db/schema'

let sessionRole: 'admin' | 'pi' | 'crc' | 'frontdesk' = 'frontdesk'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role: sessionRole, name: 'Desk Staff', userId: null })) }))

import { PATCH as confirmRoute } from '@/app/api/booking-requests/[id]/confirm/route'

const TAG = `WJC${process.pid}`
const A = `${TAG}-A`
const B = `${TAG}-B`
let providerId = 0

const req = (body: unknown) => new Request('http://localhost', { method: 'PATCH', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
const params = (id: number) => ({ params: Promise.resolve({ id: String(id) }) })

async function appt(pid: string, iso: string) {
  const startsAt = new Date(iso)
  return (await getDb().insert(appointments).values({ patientId: pid, providerId, startsAt, endsAt: new Date(startsAt.getTime() + 1800_000), visitReason: 'Review' }).returning({ id: appointments.id }))[0].id
}
async function portalRequest(kind: 'new' | 'reschedule' | 'cancel', appointmentId: number | null, pid = A) {
  return (await getDb().insert(bookingRequests).values({
    requesterName: pid, requesterDob: '1980-01-01', preferredDateRangeStart: '2099-08-01', preferredDateRangeEnd: '2099-08-05', reason: 'r', patientId: pid, requestKind: kind, appointmentId,
  }).returning({ id: bookingRequests.id }))[0].id
}
const statusOf = async (id: number) => (await getDb().select({ s: appointments.status }).from(appointments).where(eq(appointments.id, id)))[0].s

beforeAll(async () => {
  await getDb().insert(patients).values([{ id: A, name: 'Confirm A', dob: '1980-01-01' }, { id: B, name: 'Confirm B', dob: '1980-01-01' }])
  providerId = (await getDb().select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).limit(1))[0].id
})
afterEach(() => { sessionRole = 'frontdesk' })
afterAll(async () => {
  const db = getDb()
  await db.delete(bookingRequests).where(inArray(bookingRequests.patientId, [A, B]))
  await db.delete(appointments).where(inArray(appointments.patientId, [A, B]))
  await db.delete(auditLog).where(inArray(auditLog.patientId, [A, B]))
  await db.delete(patients).where(inArray(patients.id, [A, B]))
})

describe('confirming a portal cancellation request', () => {
  it('pi (read-only on the queue) is still a 403 before anything is read', async () => {
    sessionRole = 'pi'
    const res = await confirmRoute(req({}) as never, params(1))
    expect(res.status).toBe(403)
  })

  it('cancels the appointment, marks the request confirmed and audits in one go', async () => {
    const apptId = await appt(A, '2099-08-02T04:00:00Z')
    const id = await portalRequest('cancel', apptId)
    const res = await confirmRoute(req({}) as never, params(id))
    expect(res.status).toBe(200)
    expect(await statusOf(apptId)).toBe('cancelled')
    const [r] = await getDb().select().from(bookingRequests).where(eq(bookingRequests.id, id))
    expect(r).toMatchObject({ status: 'confirmed', reviewedByName: 'Desk Staff' })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, A), eq(auditLog.details, `request=${id} appointment=${apptId}`)))
    expect(audits.map((a) => a.action)).toEqual(['confirmed appointment cancellation request'])
    // A second confirm is "already resolved".
    expect((await confirmRoute(req({}) as never, params(id))).status).toBe(409)
  })

  it('an empty body for a non-cancel request is a 400; a cancel request with a slot is a 400', async () => {
    const newId = await portalRequest('new', null)
    expect((await confirmRoute(req({}) as never, params(newId))).status).toBe(400)
    const apptId = await appt(A, '2099-08-03T04:00:00Z')
    const cancelId = await portalRequest('cancel', apptId)
    const res = await confirmRoute(req({ patientId: A, providerId, startsAt: '2099-08-04T10:00:00+05:30', endsAt: '2099-08-04T10:30:00+05:30', visitReason: 'x' }) as never, params(cancelId))
    expect(res.status).toBe(400)
    expect(await statusOf(apptId)).toBe('scheduled')
  })
})

describe('confirming a portal reschedule or booking request', () => {
  it('books the new slot and releases the old appointment', async () => {
    const oldId = await appt(A, '2099-08-06T04:00:00Z')
    const id = await portalRequest('reschedule', oldId)
    const res = await confirmRoute(req({ patientId: A, providerId, startsAt: '2099-08-09T10:00:00+05:30', endsAt: '2099-08-09T10:30:00+05:30', visitReason: 'Review' }) as never, params(id))
    expect(res.status).toBe(200)
    const { appointmentId } = await res.json()
    expect(await statusOf(oldId)).toBe('cancelled')
    expect(await statusOf(appointmentId)).toBe('scheduled')
  })

  it('refuses to confirm a portal request for a different patient', async () => {
    const id = await portalRequest('new', null)
    const res = await confirmRoute(req({ patientId: B, providerId, startsAt: '2099-08-12T10:00:00+05:30', endsAt: '2099-08-12T10:30:00+05:30', visitReason: 'Review' }) as never, params(id))
    expect(res.status).toBe(400)
    expect(await getDb().select().from(appointments).where(eq(appointments.patientId, B))).toHaveLength(0)
  })
})
