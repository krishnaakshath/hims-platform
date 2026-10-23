import { describe, it, expect, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions } from '@/db/schema'
import { randomBytes } from 'node:crypto'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { readMigration, idempotencyProblems } from './migration-sql'

const FILE = '2026-10-24-ws3-admission-fields.sql'
const PID = `TEST-WS3T1-${randomBytes(4).toString('hex').toUpperCase()}`
const createdAdmissions: number[] = []
const createdRooms: number[] = []

async function ensurePatient(): Promise<{ patientId: string; providerId: number }> {
  const db = getDb()
  await db.insert(patients).values({ id: PID, name: 'Test WS3 T1', dob: '1990-01-01' }).onConflictDoNothing()
  const [provider] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
  return { patientId: PID, providerId: provider.id }
}

// Delete only what this file inserted: admissions and rooms (children) before the patient.
afterEach(async () => {
  while (createdAdmissions.length) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissions.pop()!))
  while (createdRooms.length) await getDb().delete(rooms).where(eq(rooms.id, createdRooms.pop()!))
  await getDb().delete(patients).where(eq(patients.id, PID))
})

function pgCause(err: unknown): { code?: string; constraint?: string } | undefined {
  return (err as { cause?: { code?: string; constraint?: string } } | null)?.cause
}

describe('WS3 T1 admission schema', () => {
  it('migration is idempotent and mentions every new column and the index', () => {
    const s = readMigration(FILE)
    expect(idempotencyProblems(s)).toEqual([])
    for (const c of ['expected_stay_days', 'attendant_name', 'attendant_relationship', 'attendant_phone', 'ward_gender_override_reason',
      'ward_gender_override_by_name', 'admitted_by_name', 'gender_restriction', 'admissions_one_active_per_patient',
      'admissions_expected_stay_range', 'rooms_gender_restriction_valid', 'duplicate active admissions']) expect(s).toContain(c)
  })

  it('admissions carries the reduced column set (payer and deposit live in admission_coverage)', () => {
    const names = getTableConfig(admissions).columns.map((c) => c.name)
    for (const c of ['expected_stay_days', 'attendant_name', 'attendant_relationship', 'attendant_phone', 'ward_gender_override_reason', 'ward_gender_override_by_name', 'admitted_by_name']) expect(names).toContain(c)
    expect(names).not.toContain('policy_id')
    expect(names).not.toContain('deposit_required_paise')
  })

  it('allows only one active admission per patient', async () => {
    const db = getDb()
    const { patientId, providerId } = await ensurePatient()
    const [a] = await db.insert(admissions).values({ patientId, attendingProviderId: providerId }).returning()
    createdAdmissions.push(a.id)
    const err = await db.insert(admissions).values({ patientId, attendingProviderId: providerId }).then(() => null, (e: unknown) => e)
    const cause = pgCause(err)
    expect(cause?.code).toBe('23505')
    expect(cause?.constraint).toBe('admissions_one_active_per_patient')
    const [d] = await db.insert(admissions).values({ patientId, attendingProviderId: providerId, status: 'discharged', dischargedAt: new Date() }).returning()
    createdAdmissions.push(d.id)
  })

  it('rejects an out-of-range expected stay', async () => {
    const db = getDb()
    const { patientId, providerId } = await ensurePatient()
    const err = await db.insert(admissions).values({ patientId, attendingProviderId: providerId, expectedStayDays: 400 }).then(() => null, (e: unknown) => e)
    expect(pgCause(err)?.code).toBe('23514')
    expect(pgCause(err)?.constraint).toBe('admissions_expected_stay_range')
  })

  it('rooms.gender_restriction is checked and backfilled', async () => {
    const db = getDb()
    const err = await db.execute(sql`INSERT INTO rooms (ward, room_number, bed_number, gender_restriction) VALUES ('T', 'T1', 'A', 'x')`).then(() => null, (e: unknown) => e)
    expect(pgCause(err)?.code).toBe('23514')
    expect(pgCause(err)?.constraint).toBe('rooms_gender_restriction_valid')
    const [m] = await db.insert(rooms).values({ ward: 'General Ward (Male)', roomNumber: 'ZZ1', bedNumber: 'A' }).returning()
    const [f] = await db.insert(rooms).values({ ward: 'General Ward (Female)', roomNumber: 'ZZ2', bedNumber: 'A' }).returning()
    createdRooms.push(m.id, f.id)
    expect(m.genderRestriction).toBeNull()
    // Re-run the backfill statements from the migration.
    await db.execute(sql`UPDATE rooms SET gender_restriction = 'male' WHERE id IN (${m.id}, ${f.id}) AND gender_restriction IS NULL AND ward ILIKE '%(male)%'`)
    await db.execute(sql`UPDATE rooms SET gender_restriction = 'female' WHERE id IN (${m.id}, ${f.id}) AND gender_restriction IS NULL AND ward ILIKE '%(female)%'`)
    const rows = await db.select().from(rooms).where(sql`${rooms.id} IN (${m.id}, ${f.id})`)
    expect(rows.find((r) => r.id === m.id)!.genderRestriction).toBe('male')
    expect(rows.find((r) => r.id === f.id)!.genderRestriction).toBe('female')
  })
})
