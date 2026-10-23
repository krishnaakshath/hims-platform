import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { admissionCoverage, admissions, coverageVerifications, nhcxEligibilityChecks, patientPolicies } from '@/db/schema'
import { isUniqueViolation, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from './rcm-fixtures'
import { purgeSp8Fixtures } from './sp8-fixtures'
import { purgeCoverageFixtures } from './ws12-fixtures'

const M = '2026-10-24-ws12-coverage.sql'

describe('WS12 coverage migration (static)', () => {
  it('is idempotent; the only DROP is the guarded re-creation of the eligibility context check', () => {
    const s = readMigration(M)
    const problems = idempotencyProblems(s)
    expect(problems.filter((p) => !p.startsWith('DROP is not allowed'))).toEqual([])
    expect(problems.filter((p) => p.startsWith('DROP is not allowed'))).toHaveLength(1)
    expect(s).toMatch(/pg_get_constraintdef\([\s\S]*?DROP CONSTRAINT nhcx_eligibility_checks_context_valid/)
    expect(s.replace(/--[^\n]*/g, '')).not.toMatch(/ON DELETE/)
  })
  it('declares every column and names every constraint and index (≤ 63 chars)', () => {
    const s = readMigration(M)
    for (const t of [coverageVerifications, admissionCoverage]) {
      expect(missingColumns(t, s)).toEqual([])
      const c = getTableConfig(t)
      const names = [...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!), ...c.uniqueConstraints.map((u) => u.getName()!)]
      for (const n of names) { expect(n.length, n).toBeLessThanOrEqual(63); expect(s, n).toContain(n) }
    }
    expect(s).toContain('icu_limit_paise'); expect(s).toContain('patient_policies_icu_limit_range')
  })
  it('installs the append-only trigger with the purge bypass, guarded by pg_trigger', () => {
    const s = readMigration(M)
    expect(s).toMatch(/CREATE OR REPLACE FUNCTION ws12_coverage_verifications_append_only\(\) RETURNS trigger/)
    expect(s).toMatch(/current_setting\('hims\.allow_document_purge', true\) = 'on'/)
    expect(s).toMatch(/tgname = 'ws12_coverage_verifications_append_only'[\s\S]*?CREATE TRIGGER ws12_coverage_verifications_append_only BEFORE UPDATE OR DELETE ON coverage_verifications/)
  })
})

const RUN = `${Date.now()}`.slice(-7)

describe.skipIf(!process.env.DATABASE_URL)('WS12 coverage schema (DB)', () => {
  let b: RcmBase
  let admissionId = 0
  const db = () => getDb()
  const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
  const failure = async (p: Promise<unknown>) => { const e = await errorOf(p); return { code: pgErrorCode(e), constraint: pgConstraint(e) } }
  const NOW = new Date('2026-10-23T06:30:00Z')
  const row = (over: Partial<typeof coverageVerifications.$inferInsert> = {}): typeof coverageVerifications.$inferInsert => ({
    patientId: b.patientId, policyId: b.policyId, source: 'manual', result: 'active', context: 'manual', method: 'phone',
    verifiedByName: 'Test', verifiedAt: NOW, validUntil: new Date(NOW.getTime() + 7 * 86_400_000), ...over,
  })

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'W12')
    const [a] = await db().insert(admissions).values({ patientId: b.patientId, attendingProviderId: b.providerId }).returning()
    admissionId = a.id
  })
  afterAll(async () => {
    await purgeCoverageFixtures([b.patientId], { dropAdmissions: true })
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('accepts a complete manual verification and an NHCX one tied to its check', async () => {
    const [m] = await db().insert(coverageVerifications).values(row({ insurerReference: 'R'.repeat(64), sumInsuredPaise: 5_00_000_00, copayBp: 1000, reportedValidTo: '2027-03-31', note: 'Called the TPA desk' })).returning()
    expect(m.id).toBeGreaterThan(0); expect(m.createdAt).toBeInstanceOf(Date)
    const [chk] = await db().insert(nhcxEligibilityChecks).values({ patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context: 'admission', requestedByName: 'Test' }).returning()
    await db().insert(coverageVerifications).values(row({ source: 'nhcx_mock', context: 'admission', method: null, nhcxCheckId: chk.id, validUntil: new Date(NOW.getTime() + 24 * 3_600_000) }))
    expect(isUniqueViolation(await errorOf(db().insert(coverageVerifications).values(row({ source: 'nhcx', method: null, nhcxCheckId: chk.id }))), 'coverage_verifications_nhcx_check_unique')).toBe(true)
  })

  it('a manual row without a method is refused', async () => {
    expect(await failure(db().insert(coverageVerifications).values(row({ method: null })))).toEqual({ code: '23514', constraint: 'coverage_verifications_manual_method' })
  })

  it('the document triple is all or nothing', async () => {
    expect((await failure(db().insert(coverageVerifications).values(row({ documentBlobUrl: 'https://blob.test/x', documentSha256: 'a'.repeat(64) })))).constraint).toBe('coverage_verifications_document_triple')
    expect((await failure(db().insert(coverageVerifications).values(row({ documentContentType: 'application/pdf' })))).constraint).toBe('coverage_verifications_document_triple')
    await db().insert(coverageVerifications).values(row({ documentBlobUrl: 'https://blob.test/x', documentSha256: 'a'.repeat(64), documentContentType: 'application/pdf' }))
  })

  it('valid_until must be after verified_at; enums, lengths and amounts are checked', async () => {
    expect((await failure(db().insert(coverageVerifications).values(row({ validUntil: NOW })))).constraint).toBe('coverage_verifications_valid_window')
    expect((await failure(db().insert(coverageVerifications).values(row({ source: 'fax' as never })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ result: 'maybe' as never })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ context: 'opd' as never })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ method: 'pigeon' as never })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ insurerReference: 'R'.repeat(65) })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ note: 'n'.repeat(501) })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ copayBp: 10_001 })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ balancePaise: -1 })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ icuLimitPaise: 1_000_000_000_001 })))).code).toBe('23514')
    expect((await failure(db().insert(coverageVerifications).values(row({ policyId: 2_000_000_000 })))).code).toBe('23503')
  })

  it('verifications are append-only (55000) unless the purge setting is on', async () => {
    const [v] = await db().insert(coverageVerifications).values(row()).returning()
    expect((await failure(db().update(coverageVerifications).set({ note: 'changed' }).where(eq(coverageVerifications.id, v.id)))).code).toBe('55000')
    expect((await failure(db().delete(coverageVerifications).where(eq(coverageVerifications.id, v.id)))).code).toBe('55000')
  })

  it('admission coverage: self-pay carries no policy, insured modes need one', async () => {
    const base = { admissionId, coverageState: 'no_policy', recordedByName: 'Test' } as const
    expect((await failure(db().insert(admissionCoverage).values({ ...base, mode: 'self_pay', policyId: b.policyId })))).toEqual({ code: '23514', constraint: 'admission_coverage_mode_policy' })
    expect((await failure(db().insert(admissionCoverage).values({ ...base, mode: 'cashless' })))).toEqual({ code: '23514', constraint: 'admission_coverage_mode_policy' })
    expect((await failure(db().insert(admissionCoverage).values({ ...base, mode: 'self_pay', depositRequiredPaise: 10_000_000_001 })))).toEqual({ code: '23514', constraint: 'admission_coverage_deposit_range' })
    expect((await failure(db().insert(admissionCoverage).values({ ...base, mode: 'self_pay', coverageState: 'fine' as never })))).toEqual({ code: '23514', constraint: 'admission_coverage_state_valid' })
    const [r] = await db().insert(admissionCoverage).values({ ...base, mode: 'self_pay', depositRequiredPaise: 20_000_00 }).returning()
    expect(r.depositRequiredPaise).toBe(20_000_00); expect(r.updatedAt).toBeInstanceOf(Date)
    // One row per admission.
    expect(pgErrorCode(await errorOf(db().insert(admissionCoverage).values({ ...base, mode: 'self_pay' })))).toBe('23505')
    await db().update(admissionCoverage).set({ mode: 'cashless', policyId: b.policyId, coverageState: 'unverified' }).where(eq(admissionCoverage.admissionId, admissionId))
  })

  it('nhcx_eligibility_checks accepts the checkin context', async () => {
    const [chk] = await db().insert(nhcxEligibilityChecks).values({ patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context: 'checkin', requestedByName: 'Test' }).returning()
    expect(chk.context).toBe('checkin')
  })

  it('patient_policies.icu_limit_paise is range-checked', async () => {
    await db().update(patientPolicies).set({ icuLimitPaise: 8_000_00 }).where(eq(patientPolicies.id, b.policyId))
    expect((await failure(db().update(patientPolicies).set({ icuLimitPaise: -5 }).where(eq(patientPolicies.id, b.policyId)))).constraint).toBe('patient_policies_icu_limit_range')
  })
})
