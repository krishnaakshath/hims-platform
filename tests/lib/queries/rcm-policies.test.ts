import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest'
import { and, eq, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patientPolicies, patients, payers } from '@/db/schema'
import type { Session } from '@/lib/auth'

const putPrivateBlob = vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` }))
vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: (...a: [string]) => putPrivateBlob(...a), streamPrivateBlob: vi.fn() }))

import {
  createPolicy, updatePolicy, listPatientPolicies, legacyPolicyPrefill, uploadPolicyCard, getPolicyCardBlob, findPatientsForRcm, billingPayerOf,
} from '@/lib/queries/rcm-policies'
import type { PolicyInput } from '@/lib/rcm/validation'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Policy Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }

describe.skipIf(!process.env.DATABASE_URL)('rcm policies (DB)', () => {
  let b: RcmBase
  let legacyPayerId = 0
  const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
    patientId: b.patientId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId, policyNumber: 'POL/77', memberId: 'MEM-77', policyType: 'individual',
    holderName: 'Holder', relationship: 'self', validFrom: '2026-04-01', validTo: '2027-03-31', priority: 'primary', status: 'active', ...over,
  })
  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'L')
    // the base policy is not needed here: start clean
    await getDb().delete(patientPolicies).where(eq(patientPolicies.patientId, b.patientId))
    const [legacy] = await getDb().insert(payers).values({ name: `Test SP7 Unprofiled ${RUN}`, payerId: `TSP7${RUN}U` }).returning()
    legacyPayerId = legacy.id
  })
  afterAll(async () => {
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId, legacyPayerId])
    await deleteRcmBasePatient(b.patientId)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('an active primary mirrors its billing payer onto patients.primary_payer_id', async () => {
    const r = await createPolicy(input(), RCM)
    expect(r.ok).toBe(true); if (!r.ok) return
    const primary = async () => (await getDb().select({ p: patients.primaryPayerId }).from(patients).where(eq(patients.id, b.patientId)))[0].p
    expect(await primary()).toBe(b.tpaId)
    expect(billingPayerOf({ insurerPayerId: 1, tpaPayerId: null })).toBe(1)
    expect(await updatePolicy(r.value.policyId, { status: 'inactive' }, RCM)).toEqual({ ok: true, value: null })
    expect(await primary()).toBeNull()
    expect((await updatePolicy(r.value.policyId, { status: 'active', tpaPayerId: null }, RCM)).ok).toBe(true)
    expect(await primary()).toBe(b.insurerId)
  })
  it('a second active primary is primary_exists, a secondary is fine', async () => {
    expect(await createPolicy(input({ policyNumber: 'POL/78' }), RCM)).toEqual({ ok: false, error: 'primary_exists' })
    const s = await createPolicy(input({ policyNumber: 'POL/79', priority: 'secondary' }), RCM)
    expect(s.ok).toBe(true); if (!s.ok) return
    expect(await updatePolicy(s.value.policyId, { priority: 'primary' }, RCM)).toEqual({ ok: false, error: 'primary_exists' })
    const list = await listPatientPolicies(b.patientId)
    expect(list.map((p) => p.priority)).toEqual(['primary', 'secondary'])
    expect(JSON.stringify(list)).not.toMatch(/blob/i)
  })
  it('a TPA in the insurer field is payer_kind_invalid; an unprofiled legacy payer too', async () => {
    expect(await createPolicy(input({ insurerPayerId: b.tpaId, tpaPayerId: null, priority: 'secondary' }), RCM)).toEqual({ ok: false, error: 'payer_kind_invalid' })
    expect(await createPolicy(input({ insurerPayerId: legacyPayerId, tpaPayerId: null, priority: 'secondary' }), RCM)).toEqual({ ok: false, error: 'payer_kind_invalid' })
    expect(await createPolicy(input({ tpaPayerId: b.insurerId, priority: 'secondary' }), RCM)).toEqual({ ok: false, error: 'payer_kind_invalid' })
    expect(await createPolicy(input({ patientId: 'NOPE-SP7' }), RCM)).toEqual({ ok: false, error: 'patient_not_found' })
  })
  it('legacy prefill reads the US-style fields and never writes', async () => {
    await getDb().update(patients).set({ primaryPayerId: b.tpaId, primaryMemberId: 'LEG-1', primarySubscriberName: 'Old Holder', primarySubscriberRelationship: 'spouse' }).where(eq(patients.id, b.patientId))
    const [before] = await getDb().select().from(patients).where(eq(patients.id, b.patientId))
    expect(await legacyPolicyPrefill(b.patientId)).toEqual({ tpaPayerId: b.tpaId, memberId: 'LEG-1', holderName: 'Old Holder', relationship: 'spouse' })
    const [after] = await getDb().select().from(patients).where(eq(patients.id, b.patientId))
    expect(after).toEqual(before)
  })
  it('policy audit carries no policy or member number', async () => {
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), like(auditLog.action, 'rcm: %')))
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['rcm: added policy', 'rcm: updated policy']))
    for (const r of rows) expect(`${r.details}`).not.toMatch(/POL\/|MEM-|LEG-/)
  })
  it('card upload stores the hash and never returns the URL', async () => {
    const [p] = await listPatientPolicies(b.patientId)
    const r = await uploadPolicyCard(p.id, 'front', { bytes: new TextEncoder().encode('card'), contentType: 'image/png' }, RCM)
    expect(r).toEqual({ ok: true, value: null })
    expect(putPrivateBlob).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^rcm/policies/${p.id}/[0-9a-f-]+\\.png$`)), expect.anything(), 'image/png')
    const [row] = await getDb().select().from(patientPolicies).where(eq(patientPolicies.id, p.id))
    expect(row.cardFrontSha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await listPatientPolicies(b.patientId))[0].hasCardFront).toBe(true)
    expect(await getPolicyCardBlob(p.id, 'front')).toMatchObject({ patientId: b.patientId, contentType: 'image/png' })
    expect(await getPolicyCardBlob(p.id, 'back')).toBeNull()
  })
  it('RCM patient search returns the RCM minimum', async () => {
    const hits = await findPatientsForRcm(b.patientId)
    expect(hits[0]).toEqual({ id: b.patientId, name: 'Test SP7 L', uhid: null, gender: 'female', ageYears: expect.any(Number) })
  })
})
