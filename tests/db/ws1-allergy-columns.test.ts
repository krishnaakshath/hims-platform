// WS1 T1 (lane ruling R4): allergy status on the patient and audit columns on allergies.
import { describe, it, expect, afterAll } from 'vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { allergies, patients } from '@/db/schema'
import { readMigration, idempotencyProblems } from './migration-sql'

const FILE = '2026-10-24-ws1-0-allergy-columns.sql'

describe('WS1 allergy columns (schema + migration)', () => {
  it('migration is idempotent and additive', () => {
    expect(idempotencyProblems(readMigration(FILE))).toEqual([])
  })

  it('declares the columns as the last columns of their tables', () => {
    // WS6 T8's referral columns come from a later migration (2026-10-25), so they follow it.
    expect(getTableConfig(patients).columns.slice(-3).map((c) => c.name)).toEqual(['allergy_status', 'referral_source', 'referral_note'])
    expect(getTableConfig(allergies).columns.slice(-3).map((c) => c.name)).toEqual(['recorded_by_name', 'recorded_at', 'inactivated_at'])
    const sqlText = readMigration(FILE)
    for (const name of ['allergy_status', 'recorded_by_name', 'recorded_at', 'inactivated_at', 'patients_allergy_status_valid']) {
      expect(sqlText, name).toContain(name)
    }
  })

  it('patients.allergy_status is not null with default unknown and a named check', () => {
    const cfg = getTableConfig(patients)
    const col = cfg.columns.find((c) => c.name === 'allergy_status')!
    expect(col.notNull).toBe(true)
    expect(col.default).toBe('unknown')
    expect(cfg.checks.map((c) => c.name)).toContain('patients_allergy_status_valid')
  })
})

describe.skipIf(!process.env.DATABASE_URL)('WS1 allergy columns (DB)', () => {
  const ID = `TWS1-${Date.now()}`
  afterAll(async () => {
    const { getDb } = await import('@/db/client')
    const { eq } = await import('drizzle-orm')
    await getDb().delete(allergies).where(eq(allergies.patientId, ID))
    await getDb().delete(patients).where(eq(patients.id, ID))
  })

  it('defaults allergy_status to unknown, rejects other values, and leaves allergy audit columns null', async () => {
    const { getDb } = await import('@/db/client')
    const { eq, sql } = await import('drizzle-orm')
    const db = getDb()
    const [p] = await db.insert(patients).values({ id: ID, name: 'TEST_WS1 Allergy', dob: '1990-01-01' }).returning()
    expect(p.allergyStatus).toBe('unknown')
    for (const ok of ['none_known', 'recorded', 'unknown'] as const) {
      await db.update(patients).set({ allergyStatus: ok }).where(eq(patients.id, ID))
    }
    await expect(db.execute(sql`UPDATE patients SET allergy_status = 'maybe' WHERE id = ${ID}`)).rejects.toThrow()
    const [a] = await db.insert(allergies).values({ patientId: ID, allergen: 'TEST_WS1 allergen', severity: 'mild' }).returning()
    expect(a.recordedByName).toBeNull()
    expect(a.recordedAt).toBeNull()
    expect(a.inactivatedAt).toBeNull()
  })
})
