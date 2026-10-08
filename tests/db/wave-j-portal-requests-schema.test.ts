// Wave J (P1-20): portal appointment requests on booking_requests.
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { appointments, bookingRequests, patients, providers } from '@/db/schema'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const MIGRATION = '2026-10-10-wave-j-portal-appointment-requests.sql'
const PID = `WJ-SCHEMA-${process.pid}`
let appointmentId = 0
const created: number[] = []

beforeAll(async () => {
  const db = getDb()
  await db.insert(patients).values({ id: PID, name: 'Wave J Schema', dob: '1980-01-01' })
  const [p] = await db.select({ id: providers.id }).from(providers).limit(1)
  const [a] = await db.insert(appointments).values({ patientId: PID, providerId: p.id, startsAt: new Date('2099-01-01T04:00:00Z'), endsAt: new Date('2099-01-01T04:30:00Z'), visitReason: 'Review' }).returning({ id: appointments.id })
  appointmentId = a.id
})
afterEach(async () => {
  if (created.length) await getDb().delete(bookingRequests).where(inArray(bookingRequests.id, created.splice(0)))
})
afterAll(async () => {
  await getDb().delete(bookingRequests).where(eq(bookingRequests.patientId, PID))
  await getDb().delete(appointments).where(eq(appointments.patientId, PID))
  await getDb().delete(patients).where(eq(patients.id, PID))
})

const base = { requesterName: 'Wave J Schema', requesterDob: '1980-01-01', preferredDateRangeStart: '2099-01-02', preferredDateRangeEnd: '2099-01-05', reason: 'x' }

describe('Wave J booking_requests portal columns', () => {
  it('the migration is idempotent and declares every column and constraint name', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    const missing = missingColumns(bookingRequests, s)
    for (const col of ['patient_id', 'request_kind', 'appointment_id']) expect(missing).not.toContain(col)
    const c = getTableConfig(bookingRequests)
    const names = [...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!), ...c.foreignKeys.map((f) => f.getName())]
    for (const n of names.filter((n) => !n.includes('preferred_provider') && !n.includes('resulting_appointment'))) expect(s, n).toContain(n)
  })

  it('a public request defaults to kind new with no patient or appointment', async () => {
    const [row] = await getDb().insert(bookingRequests).values(base).returning()
    created.push(row.id)
    expect(row.requestKind).toBe('new')
    expect(row.patientId).toBeNull()
    expect(row.appointmentId).toBeNull()
  })

  it('a cancel request needs an appointment and a patient', async () => {
    await expect(getDb().insert(bookingRequests).values({ ...base, requestKind: 'cancel', patientId: PID })).rejects.toThrow()
    await expect(getDb().insert(bookingRequests).values({ ...base, requestKind: 'cancel', appointmentId })).rejects.toThrow()
    await expect(getDb().insert(bookingRequests).values({ ...base, requestKind: 'new', patientId: PID, appointmentId })).rejects.toThrow()
  })

  it('allows only one pending request per appointment', async () => {
    const [a] = await getDb().insert(bookingRequests).values({ ...base, requestKind: 'cancel', patientId: PID, appointmentId }).returning()
    created.push(a.id)
    await expect(getDb().insert(bookingRequests).values({ ...base, requestKind: 'reschedule', patientId: PID, appointmentId })).rejects.toThrow()
    await getDb().update(bookingRequests).set({ status: 'declined' }).where(eq(bookingRequests.id, a.id))
    const [b] = await getDb().insert(bookingRequests).values({ ...base, requestKind: 'reschedule', patientId: PID, appointmentId }).returning()
    created.push(b.id)
    expect(b.status).toBe('pending')
  })
})
