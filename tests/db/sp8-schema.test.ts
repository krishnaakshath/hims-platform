import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { abdmConsents, abdmProfileShares, nhcxExchanges, nhcxInboundCalls, nhcxEligibilityChecks, patients, claims, claimSubmissions } from '@/db/schema'
import { isUniqueViolation, pgErrorCode } from '@/lib/db-errors'
import { readMigration, idempotencyProblems, missingColumns } from './migration-sql'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from './rcm-fixtures'
import { purgeSp8Fixtures, purgeSp8InboundCalls, purgeSp8Shares } from './sp8-fixtures'

const M = '2026-10-10-sp8-abdm-nhcx.sql'
const TABLES = [abdmConsents, abdmProfileShares, nhcxExchanges, nhcxInboundCalls, nhcxEligibilityChecks] as const

describe('SP8 migration (static)', () => {
  it('migration is idempotent and declares every column', () => {
    const s = readMigration(M); expect(idempotencyProblems(s)).toEqual([])
    for (const t of TABLES) expect(missingColumns(t, s)).toEqual([])
    for (const c of ['abha_verified_at', 'abha_verification_source', 'abha_verified_via', 'patients_abha_verification_complete', 'nhcx_exchanges_submission_unique', 'nhcx_exchanges_payload_direction', 'abdm_profile_shares_expired_scrubbed', 'nhcx_inbound_calls_append_only', 'abdm_consents_append_only']) expect(s).toContain(c)
    expect(s).not.toMatch(/\bUPDATE\s+patients\b/i); expect(s).not.toMatch(/aadhaar/i)
    expect(s).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i)
  })
  it('every FK, unique, check and index name is in the SQL and fits 63 chars; no ON DELETE', () => {
    const s = readMigration(M)
    for (const t of [...TABLES, patients]) {
      const c = getTableConfig(t)
      const names = [
        ...c.foreignKeys.map((f) => f.getName()), ...c.checks.map((k) => k.name), ...c.indexes.map((i) => i.config.name!),
        ...c.uniqueConstraints.map((u) => u.getName()!),
      ]
      for (const n of names) {
        expect(n.length, n).toBeLessThanOrEqual(63)
        if (t !== patients || n.startsWith('patients_abha_verification')) expect(s, n).toContain(n)
      }
      for (const fk of c.foreignKeys) if (t !== patients) expect(fk.onDelete ?? 'no action', fk.getName()).toBe('no action')
    }
    expect(s.replace(/--[^\n]*/g, '')).not.toMatch(/ON DELETE/)
  })
  it('both triggers are created inside a DO block that tests pg_trigger, and the purge setting is honoured', () => {
    const s = readMigration(M)
    for (const t of ['nhcx_inbound_calls_append_only', 'abdm_consents_append_only']) expect(s).toMatch(new RegExp(`tgname = '${t}'[\\s\\S]*?CREATE TRIGGER ${t} BEFORE UPDATE OR DELETE`))
    expect(s.match(/current_setting\('hims\.allow_document_purge', true\) = 'on'/g)!.length).toBe(2)
  })
})

const RUN = `${Date.now()}`.slice(-7)

describe.skipIf(!process.env.DATABASE_URL)('SP8 schema (DB)', () => {
  let b: RcmBase
  let claimId = 0
  let submissionId = 0
  const inboundIds: string[] = []
  const db = () => getDb()
  const errorOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e)
  const code = async (p: Promise<unknown>) => pgErrorCode(await errorOf(p))
  const exchange = (over: Partial<typeof nhcxExchanges.$inferInsert> = {}): typeof nhcxExchanges.$inferInsert => ({
    entityType: 'claim', direction: 'outbound', action: 'claim/submit', correlationId: randomUUID(), apiCallId: randomUUID(),
    senderCode: 'P1@sbx', recipientCode: 'TPA1@sbx', state: 'pending_send', patientId: b.patientId, bodySha256: 'a'.repeat(64), ...over,
  })

  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'S8')
    const [c] = await db().insert(claims).values({
      claimNumber: `CLM-2099-S8${RUN}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId, billingPayerId: b.tpaId,
      claimType: 'opd', encounterId: b.encounterId, createdByName: 'Test', status: 'submitted', claimedPaise: 100_000,
    }).returning()
    claimId = c.id
    const [s] = await db().insert(claimSubmissions).values({
      claimId, version: 1, kind: 'initial', snapshot: {} as never, snapshotSha256: 'a'.repeat(64), rcmCopyBlobUrl: 'https://blob.test/r', rcmCopySha256: 'b'.repeat(64),
      insurerCopyBlobUrl: 'https://blob.test/i', insurerCopySha256: 'c'.repeat(64), createdByName: 'Test',
    }).returning()
    submissionId = s.id
  })
  afterAll(async () => {
    await purgeSp8InboundCalls(inboundIds)
    await purgeSp8Shares(`TEST-SP8-${RUN}`)
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })

  it('one outbound exchange per claim submission', async () => {
    await db().insert(nhcxExchanges).values(exchange({ claimId, claimSubmissionId: submissionId, policyId: b.policyId }))
    expect(isUniqueViolation(await errorOf(db().insert(nhcxExchanges).values(exchange({ claimId, claimSubmissionId: submissionId }))), 'nhcx_exchanges_submission_unique')).toBe(true)
    // An inbound response on the same version is fine.
    await expect(db().insert(nhcxExchanges).values(exchange({ claimId, claimSubmissionId: submissionId, direction: 'inbound', action: 'claim/on_submit', state: 'received' }))).resolves.toBeDefined()
  })
  it('a replayed api_call_id is a unique violation', async () => {
    const apiCallId = randomUUID()
    await db().insert(nhcxExchanges).values(exchange({ apiCallId }))
    expect(isUniqueViolation(await errorOf(db().insert(nhcxExchanges).values(exchange({ apiCallId }))), 'nhcx_exchanges_api_call_unique')).toBe(true)
    const id = randomUUID(); inboundIds.push(id)
    await db().insert(nhcxInboundCalls).values({ apiCallId: id, action: 'claim/on_submit', senderCode: 'TPA1@sbx', correlationId: randomUUID(), outcome: 'accepted' })
    expect(pgErrorCode(await errorOf(db().insert(nhcxInboundCalls).values({ apiCallId: id, action: 'claim/on_submit', senderCode: 'TPA1@sbx', correlationId: randomUUID(), outcome: 'accepted' })))).toBe('23505')
  })
  it('payloads follow the direction, attempts stay in range, states are checked', async () => {
    expect(await code(db().insert(nhcxExchanges).values(exchange({ payloadEncrypted: 'x' })))).toBe('23514')
    expect(await code(db().insert(nhcxExchanges).values(exchange({ direction: 'inbound', state: 'received', jweEncrypted: 'x' })))).toBe('23514')
    expect(await code(db().insert(nhcxExchanges).values(exchange({ attempts: 11 })))).toBe('23514')
    expect(await code(db().insert(nhcxExchanges).values(exchange({ state: 'done' as never })))).toBe('23514')
  })
  it('an expired share must be scrubbed', async () => {
    const base = { hipId: 'HFR1', counterId: 'C1', intent: 'REGISTRATION', tokenDate: '2099-01-01' }
    expect(await code(db().insert(abdmProfileShares).values({ ...base, requestId: `TEST-SP8-${RUN}-1`, tokenNumber: 1, status: 'expired', name: 'Someone' }))).toBe('23514')
    const [row] = await db().insert(abdmProfileShares).values({ ...base, requestId: `TEST-SP8-${RUN}-2`, tokenNumber: 2, name: 'Someone', abhaNumber: '91111122223333' }).returning()
    expect(await code(db().update(abdmProfileShares).set({ status: 'expired' }).where(eq(abdmProfileShares.id, row.id)))).toBe('23514')
    await db().update(abdmProfileShares).set({ status: 'expired', name: null, abhaNumber: null }).where(eq(abdmProfileShares.id, row.id))
    expect(isUniqueViolation(await errorOf(db().insert(abdmProfileShares).values({ ...base, requestId: `TEST-SP8-${RUN}-3`, tokenNumber: 2 })), 'abdm_profile_shares_token_unique')).toBe(true)
    expect(isUniqueViolation(await errorOf(db().insert(abdmProfileShares).values({ ...base, requestId: `TEST-SP8-${RUN}-2`, tokenNumber: 9 })), 'abdm_profile_shares_request_unique')).toBe(true)
  })
  it('inbound calls and consents are append-only', async () => {
    const id = randomUUID(); inboundIds.push(id)
    await db().insert(nhcxInboundCalls).values({ apiCallId: id, action: 'claim/on_submit', senderCode: 'TPA1@sbx', correlationId: randomUUID(), outcome: 'accepted' })
    expect(await code(db().update(nhcxInboundCalls).set({ outcome: 'rejected' }).where(eq(nhcxInboundCalls.apiCallId, id)))).toBe('55000')
    expect(await code(db().delete(nhcxInboundCalls).where(eq(nhcxInboundCalls.apiCallId, id)))).toBe('55000')

    const [c] = await db().insert(abdmConsents).values({
      flowId: randomUUID(), purpose: 'abha_verification', consentCode: 'abha-enrollment', consentVersion: '1.4', textSha256: 'f'.repeat(64), givenBy: 'patient', recordedByName: 'Test',
    }).returning()
    expect(await code(db().update(abdmConsents).set({ givenBy: 'guardian' }).where(eq(abdmConsents.id, c.id)))).toBe('55000')
    expect(await code(db().update(abdmConsents).set({ patientId: b.patientId, givenBy: 'guardian' }).where(eq(abdmConsents.id, c.id)))).toBe('55000')
    await db().update(abdmConsents).set({ patientId: b.patientId }).where(eq(abdmConsents.id, c.id))
    const [other] = await db().select({ id: patients.id }).from(patients).where(eq(patients.id, b.patientId))
    expect(await code(db().update(abdmConsents).set({ patientId: other.id }).where(eq(abdmConsents.id, c.id)))).toBe('55000')
    expect(await code(db().delete(abdmConsents).where(eq(abdmConsents.id, c.id)))).toBe('55000')
    expect(await code(db().insert(abdmConsents).values({ flowId: 'f', purpose: 'other' as never, consentCode: 'x', consentVersion: '1', textSha256: 'x', givenBy: 'patient', recordedByName: 'T' }))).toBe('23514')
  })
  it('ABHA verification columns are all-or-nothing', async () => {
    expect(await code(db().update(patients).set({ abhaVerifiedAt: new Date() }).where(eq(patients.id, b.patientId)))).toBe('23514')
    expect(await code(db().update(patients).set({ abhaVerifiedAt: new Date(), abhaVerificationSource: 'abdm' }).where(eq(patients.id, b.patientId)))).toBe('23514')
    expect(await code(db().update(patients).set({ abhaVerifiedAt: new Date(), abhaVerificationSource: 'elsewhere' as never, abhaVerifiedVia: 'mobile_otp' }).where(eq(patients.id, b.patientId)))).toBe('23514')
    await db().update(patients).set({ abhaVerifiedAt: new Date(), abhaVerificationSource: 'abdm_sandbox_mock', abhaVerifiedVia: 'mobile_otp' }).where(eq(patients.id, b.patientId))
    await db().update(patients).set({ abhaVerifiedAt: null, abhaVerificationSource: null, abhaVerifiedVia: null }).where(eq(patients.id, b.patientId))
  })
  it('an eligibility check needs its policy and payer', async () => {
    const [chk] = await db().insert(nhcxEligibilityChecks).values({ patientId: b.patientId, policyId: b.policyId, payerId: b.insurerId, purpose: 'validation', context: 'manual', requestedByName: 'Test' }).returning()
    expect(chk.status).toBe('pending')
    expect(await code(db().insert(nhcxEligibilityChecks).values({ patientId: b.patientId, policyId: 2_000_000_000, payerId: b.insurerId, purpose: 'validation', context: 'manual', requestedByName: 'Test' }))).toBe('23503')
  })
})
