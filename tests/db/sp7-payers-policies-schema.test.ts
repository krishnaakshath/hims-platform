import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import {
  payers, patients, payerProfiles, payerNetworks, payerContacts, payerDocumentRequirements, rcmReasonCodes, patientPolicies,
  payerKindEnum, submissionChannelEnum, empanelmentStatusEnum, policyTypeEnum, policyRelationshipEnum, policyPriorityEnum,
  policyStatusEnum, claimTypeEnum, claimDocumentKindEnum, rcmReasonCategoryEnum,
} from '@/db/schema'
import {
  PAYER_KINDS, SUBMISSION_CHANNELS, EMPANELMENT_STATUSES, POLICY_TYPES, POLICY_RELATIONSHIPS, POLICY_PRIORITIES, POLICY_STATUSES,
  CLAIM_TYPES, CLAIM_DOCUMENT_KINDS, REASON_CATEGORIES,
} from '@/lib/rcm/constants'
import { isUniqueViolation } from '@/lib/db-errors'
import { listPayers, getPayerById } from '@/lib/queries/payers'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'

const M = '2026-10-09-sp7-b-payers-policies.sql'
const TABLES = [payerProfiles, payerNetworks, payerContacts, payerDocumentRequirements, rcmReasonCodes, patientPolicies] as const

describe('SP7 migration B (payers and policies)', () => {
  it('migration B is idempotent and declares every column', () => {
    const s = readMigration(M); expect(idempotencyProblems(s)).toEqual([])
    for (const t of TABLES) expect(missingColumns(t, s)).toEqual([])
    for (const c of ['rohini_id', 'hfr_id']) expect(s).toContain(c)
    expect(s).not.toMatch(/\bUPDATE\s+(payers|patients)\b/i)
  })
  it('pins every named constraint and seeds every reason code', () => {
    const s = readMigration(M)
    for (const n of ['patient_policies_one_active_primary', 'patient_policies_card_pairs', 'payer_networks_pair_unique', 'payer_document_requirements_unique', 'rcm_reason_codes_code_format', 'payer_profiles_sla_ranges']) expect(s).toContain(n)
    for (const c of ['NME', 'RRP', 'COPAY', 'SUBLIMIT', 'TARIFF', 'EXCL', 'PED', 'WAIT', 'NONDISC', 'LATE', 'DUP', 'DOCS', 'CLARIFY', 'SHORTPAY', 'BANK', 'ABSORB', 'OTHER']) expect(s).toMatch(new RegExp(`'${c}'`))
    expect(s).toContain('ON CONFLICT (code) DO NOTHING')
  })
  it('every FK, check and index name is in the SQL and fits 63 chars; no ON DELETE', () => {
    const s = readMigration(M)
    for (const t of TABLES) {
      const c = getTableConfig(t)
      for (const n of [...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!)]) {
        expect(n.length, n).toBeLessThanOrEqual(63); expect(s, n).toContain(n)
      }
      for (const fk of c.foreignKeys) expect(fk.onDelete ?? 'no action').toBe('no action')
    }
    expect(s.replace(/--[^\n]*/g, '')).not.toMatch(/ON DELETE/)
  })
  it('pgEnum values match the pure constants and the migration', () => {
    const s = readMigration(M)
    const pairs = [
      [payerKindEnum, PAYER_KINDS], [submissionChannelEnum, SUBMISSION_CHANNELS], [empanelmentStatusEnum, EMPANELMENT_STATUSES],
      [policyTypeEnum, POLICY_TYPES], [policyRelationshipEnum, POLICY_RELATIONSHIPS], [policyPriorityEnum, POLICY_PRIORITIES],
      [policyStatusEnum, POLICY_STATUSES], [claimTypeEnum, CLAIM_TYPES], [claimDocumentKindEnum, CLAIM_DOCUMENT_KINDS], [rcmReasonCategoryEnum, REASON_CATEGORIES],
    ] as const
    for (const [e, values] of pairs) {
      expect(e.enumValues).toEqual([...values])
      expect(s, e.enumName).toContain(`CREATE TYPE ${e.enumName} AS ENUM (${e.enumValues.map((v) => `'${v}'`).join(', ')});`)
    }
  })
  it('money columns are bigint', () => {
    const type = (n: string) => getTableConfig(patientPolicies).columns.find((c) => c.name === n)!.getSQLType()
    expect(type('sum_insured_paise')).toBe('bigint'); expect(type('room_rent_limit_paise')).toBe('bigint')
  })
})

const RUN = `${Date.now()}`.slice(-7)
const PID = `TEST-SP7-${RUN}-B1`

describe.skipIf(!process.env.DATABASE_URL)('payers and policies (DB)', () => {
  let insurerId = 0
  let legacyId = 0
  beforeAll(async () => {
    const db = getDb()
    await db.insert(patients).values({ id: PID, name: 'Test SP7 Policies', dob: '1990-01-01' })
    const [ins] = await db.insert(payers).values({ name: `Test SP7 Insurer ${RUN}`, payerId: `TSP7${RUN}I`, payerType: 'other' }).returning()
    const [leg] = await db.insert(payers).values({ name: `Test SP7 Legacy ${RUN}`, payerId: `TSP7${RUN}L` }).returning()
    insurerId = ins.id; legacyId = leg.id
    await db.insert(payerProfiles).values({ payerId: insurerId, kind: 'insurer', updatedByName: 'Test' })
  })
  afterAll(async () => {
    const db = getDb()
    await db.delete(patientPolicies).where(eq(patientPolicies.patientId, PID))
    await db.delete(payerProfiles).where(inArray(payerProfiles.payerId, [insurerId, legacyId]))
    await db.delete(payers).where(inArray(payers.id, [insurerId, legacyId]))
    await db.delete(patients).where(eq(patients.id, PID))
  })
  const policy = (over: Partial<typeof patientPolicies.$inferInsert> = {}) => ({
    patientId: PID, insurerPayerId: insurerId, policyNumber: 'POL-1', memberId: 'M-1', policyType: 'individual' as const, holderName: 'Holder',
    relationship: 'self' as const, validFrom: '2026-04-01', validTo: '2027-03-31', createdByName: 'Test', ...over,
  })

  it('allows one active primary policy per patient', async () => {
    const db = getDb()
    await db.insert(patientPolicies).values(policy())
    const err = await db.insert(patientPolicies).values(policy({ policyNumber: 'POL-2' })).then(() => null, (e: unknown) => e)
    expect(isUniqueViolation(err, 'patient_policies_one_active_primary')).toBe(true)
    await expect(db.insert(patientPolicies).values(policy({ policyNumber: 'POL-3', priority: 'secondary' }))).resolves.toBeDefined()
    await expect(db.insert(patientPolicies).values(policy({ policyNumber: 'POL-4', status: 'inactive' }))).resolves.toBeDefined()
  })
  it('refuses a half card (URL without hash) and an end date before the start', async () => {
    const db = getDb()
    await expect(db.insert(patientPolicies).values(policy({ priority: 'secondary', cardFrontBlobUrl: 'https://blob.test/x' }))).rejects.toThrow()
    await expect(db.insert(patientPolicies).values(policy({ priority: 'secondary', validTo: '2026-01-01' }))).rejects.toThrow()
  })
  it('a legacy payer row without a profile still reads', async () => {
    expect((await listPayers()).some((p) => p.id === legacyId)).toBe(true)
    expect((await getPayerById(legacyId))?.name).toBe(`Test SP7 Legacy ${RUN}`)
    expect(await getDb().select().from(payerProfiles).where(eq(payerProfiles.payerId, legacyId))).toEqual([])
  })
  it('stores a sum insured above 2^31', async () => {
    const [row] = await getDb().insert(patientPolicies).values(policy({ policyNumber: 'POL-BIG', priority: 'secondary', sumInsuredPaise: 5_00_00_000_00 })).returning()
    expect(row.sumInsuredPaise).toBe(5_00_00_000_00)
  })
  it('the reason codes are seeded', async () => {
    const rows = await getDb().select().from(rcmReasonCodes)
    expect(rows.find((r) => r.code === 'NME')).toMatchObject({ category: 'disallowance', patientRecoverableDefault: true, sortOrder: 10 })
    expect(rows.find((r) => r.code === 'OTHER')?.sortOrder).toBe(999)
  })
})
