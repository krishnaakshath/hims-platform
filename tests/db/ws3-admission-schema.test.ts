import { describe, it, expect, afterEach } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { rooms, providers, patients, admissions } from '@/db/schema'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { readMigration, idempotencyProblems } from './migration-sql'

const FILE = '2026-10-24-ws3-admission-fields.sql'
const createdAdmissions: number[] = []
const createdRooms: number[] = []

afterEach(async () => {
  while (createdAdmissions.length) await getDb().delete(admissions).where(eq(admissions.id, createdAdmissions.pop()!))
  while (createdRooms.length) await getDb().delete(rooms).where(eq(rooms.id, createdRooms.pop()!))
})

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
    const [provider] = await db.select().from(providers).limit(1)
    const [patient] = await db.select().from(patients).limit(1)
    await db.delete(admissions).where(eq(admissions.patientId, patient.id))
    const [a] = await db.insert(admissions).values({ patientId: patient.id, attendingProviderId: provider.id }).returning()
    createdAdmissions.push(a.id)
    const err = await db.insert(admissions).values({ patientId: patient.id, attendingProviderId: provider.id }).then(() => null, (e: unknown) => e)
    const cause = (err as { cause?: { code?: string; constraint?: string } } | null)?.cause
    expect(cause?.code).toBe('23505')
    expect(cause?.constraint).toBe('admissions_one_active_per_patient')
    const [d] = await db.insert(admissions).values({ patientId: patient.id, attendingProviderId: provider.id, status: 'discharged', dischargedAt: new Date() }).returning()
    createdAdmissions.push(d.id)
  })

  it('rejects an out-of-range expected stay', async () => {
    const db = getDb()
    const [provider] = await db.select().from(providers).limit(1)
    const [patient] = await db.select().from(patients).limit(1)
    await db.delete(admissions).where(eq(admissions.patientId, patient.id))
    await expect(db.insert(admissions).values({ patientId: patient.id, attendingProviderId: provider.id, expectedStayDays: 400 })).rejects.toThrow()
  })

  it('rooms.gender_restriction is checked and backfilled', async () => {
    const db = getDb()
    await expect(db.execute(sql`INSERT INTO rooms (ward, room_number, bed_number, gender_restriction) VALUES ('T', 'T1', 'A', 'x')`)).rejects.toThrow()
    const [m] = await db.insert(rooms).values({ ward: 'General Ward (Male)', roomNumber: 'ZZ1', bedNumber: 'A' }).returning()
    const [f] = await db.insert(rooms).values({ ward: 'General Ward (Female)', roomNumber: 'ZZ2', bedNumber: 'A' }).returning()
    createdRooms.push(m.id, f.id)
    expect(m.genderRestriction).toBeNull()
    // Re-run the backfill statements from the migration.
    await db.execute(sql`UPDATE rooms SET gender_restriction = 'male' WHERE gender_restriction IS NULL AND ward ILIKE '%(male)%'`)
    await db.execute(sql`UPDATE rooms SET gender_restriction = 'female' WHERE gender_restriction IS NULL AND ward ILIKE '%(female)%'`)
    const rows = await db.select().from(rooms).where(sql`${rooms.id} IN (${m.id}, ${f.id})`)
    expect(rows.find((r) => r.id === m.id)!.genderRestriction).toBe('male')
    expect(rows.find((r) => r.id === f.id)!.genderRestriction).toBe('female')
  })
})
