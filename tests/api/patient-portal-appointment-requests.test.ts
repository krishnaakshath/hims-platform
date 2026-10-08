// Wave J (P1-20): POST /api/patient-portal/appointment-requests against the real database.
// A request is filed for the SESSION patient only; another patient's appointment is a 404
// with nothing written; a second pending request for one appointment is a 409; every filed
// request has its audit row.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, auditLog, bookingRequests, patients, providers } from '@/db/schema'

const h = vi.hoisted(() => ({ session: null as string | null, allowed: true }))
vi.mock('@/lib/patient-session', () => ({
  requirePatientSession: vi.fn(async () => (h.session ? { patientId: h.session } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }))),
}))
vi.mock('@/lib/rate-limit', () => ({ checkPortalAppointmentRequestRateLimit: vi.fn(async () => ({ allowed: h.allowed })) }))
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => { throw new Error('staff session must not be used') }) }))

import { POST } from '@/app/api/patient-portal/appointment-requests/route'
import { checkPortalAppointmentRequestRateLimit } from '@/lib/rate-limit'
import { todayIsoIn } from '@/lib/india-time'

// Preferred dates must fall within the next year (IST), so they are relative to today.
const plusDays = (n: number) => new Date(Date.parse(`${todayIsoIn()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const D1 = plusDays(10)
const D2 = plusDays(19)

const TAG = `WJA${process.pid}`
const A = `${TAG}-A`
const B = `${TAG}-B`
let providerId = 0
let apptA = 0
let apptPastA = 0
let apptB = 0

const call = (body: unknown) => POST(new NextRequest('http://localhost/api/patient-portal/appointment-requests', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }))
const requestsOf = (pid: string) => getDb().select().from(bookingRequests).where(eq(bookingRequests.patientId, pid))

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values([
    { id: A, name: 'Request Patient A', dob: '1980-02-03', phone: '+91 98450 00001', email: 'a@example.com' },
    { id: B, name: 'Request Patient B', dob: '1981-02-03' },
  ])
  const [p] = await db.select({ id: providers.id }).from(providers).where(eq(providers.isActive, true)).limit(1)
  providerId = p.id
  const mk = async (pid: string, startsAt: Date) => (await db.insert(appointments).values({ patientId: pid, providerId, startsAt, endsAt: new Date(startsAt.getTime() + 1800_000), visitReason: 'Diabetes review' }).returning({ id: appointments.id }))[0].id
  apptA = await mk(A, new Date('2099-03-10T04:30:00Z'))
  apptPastA = await mk(A, new Date('2001-03-10T04:30:00Z'))
  apptB = await mk(B, new Date('2099-03-10T04:30:00Z'))
})

beforeEach(async () => {
  h.session = A
  h.allowed = true
  await getDb().delete(bookingRequests).where(inArray(bookingRequests.patientId, [A, B]))
})

afterAll(async () => {
  const db = getDb()
  await db.delete(bookingRequests).where(inArray(bookingRequests.patientId, [A, B]))
  await db.delete(appointments).where(inArray(appointments.patientId, [A, B]))
  await db.delete(auditLog).where(inArray(auditLog.patientId, [A, B]))
  await db.delete(patients).where(inArray(patients.id, [A, B]))
})

describe('POST /api/patient-portal/appointment-requests', () => {
  it('no patient session -> 401 before the rate limiter or any read', async () => {
    h.session = null
    vi.mocked(checkPortalAppointmentRequestRateLimit).mockClear()
    expect((await call({ kind: 'cancel', appointmentId: apptA })).status).toBe(401)
    expect(checkPortalAppointmentRequestRateLimit).not.toHaveBeenCalled()
  })

  it('a malformed body is the fixed 400 Invalid JSON (never a 500)', async () => {
    const res = await POST(new NextRequest('http://localhost/api/patient-portal/appointment-requests', { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid JSON' })
  })

  it('rate limited -> 429 and nothing written', async () => {
    h.allowed = false
    expect((await call({ kind: 'cancel', appointmentId: apptA })).status).toBe(429)
    expect(await requestsOf(A)).toHaveLength(0)
  })

  it('files a new-visit request named to the session patient from the patient master, and audits it', async () => {
    const res = await call({ kind: 'new', preferredProviderId: providerId, preferredDateRangeStart: D1, preferredDateRangeEnd: D2, reason: 'Knee pain', requesterName: 'Someone Else' })
    expect(res.status).toBe(400) // .strict(): a body cannot name the requester

    const ok = await call({ kind: 'new', preferredProviderId: providerId, preferredDateRangeStart: D1, preferredDateRangeEnd: D2, reason: 'Knee pain' })
    expect(ok.status).toBe(201)
    const { id } = await ok.json()
    const [row] = await requestsOf(A)
    expect(row).toMatchObject({ id, requestKind: 'new', patientId: A, appointmentId: null, requesterName: 'Request Patient A', requesterDob: '1980-02-03', requesterPhone: '+91 98450 00001', status: 'pending', reason: 'Knee pain' })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, A), eq(auditLog.details, `request=${id}`)))
    expect(audits.map((a) => a.action)).toEqual(['requested appointment booking via patient portal'])
  })

  it('cancel of an own upcoming appointment is filed with the appointment day', async () => {
    const res = await call({ kind: 'cancel', appointmentId: apptA })
    expect(res.status).toBe(201)
    const [row] = await requestsOf(A)
    expect(row).toMatchObject({ requestKind: 'cancel', appointmentId: apptA, preferredDateRangeStart: '2099-03-10', preferredDateRangeEnd: '2099-03-10' })
  })

  it('another patient\'s appointment is a 404 and nothing is written for either patient', async () => {
    for (const body of [{ kind: 'cancel', appointmentId: apptB }, { kind: 'reschedule', appointmentId: apptB, preferredDateRangeStart: D1, preferredDateRangeEnd: D2 }]) {
      const res = await call(body)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Appointment not found' })
    }
    expect(await requestsOf(A)).toHaveLength(0)
    expect(await requestsOf(B)).toHaveLength(0)
  })

  it('a past appointment cannot be changed (404)', async () => {
    expect((await call({ kind: 'cancel', appointmentId: apptPastA })).status).toBe(404)
  })

  it('a second pending request for the same appointment is a 409', async () => {
    expect((await call({ kind: 'reschedule', appointmentId: apptA, preferredDateRangeStart: D1, preferredDateRangeEnd: D2 })).status).toBe(201)
    const dup = await call({ kind: 'cancel', appointmentId: apptA })
    expect(dup.status).toBe(409)
    expect(await requestsOf(A)).toHaveLength(1)
  })

  it('rejects bad dates and unknown doctors', async () => {
    expect((await call({ kind: 'new', preferredDateRangeStart: '2001-01-01', preferredDateRangeEnd: '2001-01-02', reason: 'x' })).status).toBe(400)
    expect((await call({ kind: 'new', preferredDateRangeStart: D2, preferredDateRangeEnd: D1, reason: 'x' })).status).toBe(400)
    expect((await call({ kind: 'new', preferredDateRangeStart: '2099-02-30', preferredDateRangeEnd: '2099-03-01', reason: 'x' })).status).toBe(400)
    expect((await call({ kind: 'new', preferredDateRangeStart: plusDays(400), preferredDateRangeEnd: plusDays(401), reason: 'x' })).status).toBe(400)
    expect((await call({ kind: 'new', preferredDateRangeStart: D1, preferredDateRangeEnd: plusDays(200), reason: 'x' })).status).toBe(400)
    expect((await call({ kind: 'new', preferredProviderId: 2_000_000_000, preferredDateRangeStart: D1, preferredDateRangeEnd: D2, reason: 'x' })).status).toBe(400)
    expect((await call({ kind: 'new', preferredDateRangeStart: D1, preferredDateRangeEnd: D2, reason: '' })).status).toBe(400)
    expect((await call({ kind: 'delete', appointmentId: apptA })).status).toBe(400)
    expect(await requestsOf(A)).toHaveLength(0)
  })
})
