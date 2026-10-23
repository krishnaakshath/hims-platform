// WS7 T6 (spec D20): appointments.visit_mode and booking_requests.requested_visit_mode.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appointments, patients, providers } from '@/db/schema'
import { readMigration, idempotencyProblems } from './migration-sql'

const MIGRATION = '2026-10-26-ws7-visit-mode.sql'
const PID = `WS7-VM-${process.pid}`
let providerId = 0

beforeAll(async () => {
  await getDb().insert(patients).values({ id: PID, name: 'Visit Mode Schema', dob: '1980-01-01' })
  ;[{ id: providerId }] = await getDb().select({ id: providers.id }).from(providers).limit(1)
})
afterAll(async () => {
  await getDb().delete(appointments).where(eq(appointments.patientId, PID))
  await getDb().delete(patients).where(eq(patients.id, PID))
})

const slot = (h: number) => ({ startsAt: new Date(`2099-02-01T0${h}:00:00Z`), endsAt: new Date(`2099-02-01T0${h}:30:00Z`) })

describe('WS7 T6 visit mode columns', () => {
  it('the migration is idempotent and declares both columns and check constraints', () => {
    const s = readMigration(MIGRATION)
    expect(idempotencyProblems(s)).toEqual([])
    for (const n of ['visit_mode', 'requested_visit_mode', 'appointments_visit_mode_valid', 'booking_requests_requested_visit_mode_valid']) expect(s).toContain(n)
  })

  it('an appointment defaults to in_person and rejects an unknown mode', async () => {
    const [row] = await getDb().insert(appointments).values({ patientId: PID, providerId, visitReason: 'VM', ...slot(1) }).returning()
    expect(row.visitMode).toBe('in_person')
    await expect(getDb().insert(appointments).values({ patientId: PID, providerId, visitReason: 'VM', ...slot(2), visitMode: 'phone' as never })).rejects.toThrow()
  })
})
