import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { signatures } from '@/db/schema'
import { hasAcceptedCurrentPolicies, recordPolicyAcceptance, getLatestPolicyDocument } from '@/lib/queries/policy-documents'

const createdSignatureIds: number[] = []
afterEach(async () => {
  while (createdSignatureIds.length > 0) await getDb().delete(signatures).where(eq(signatures.id, createdSignatureIds.pop()!))
})

async function trackAcceptance(patientId: string) {
  await recordPolicyAcceptance(patientId, 'Test Patient')
  const rows = await getDb().select({ id: signatures.id }).from(signatures).where(eq(signatures.patientId, patientId))
  for (const r of rows) createdSignatureIds.push(r.id)
}

describe('policy-documents queries', () => {
  it('has a current npp and tos document seeded', async () => {
    const [npp, tos] = await Promise.all([getLatestPolicyDocument('npp'), getLatestPolicyDocument('tos')])
    expect(npp).not.toBeNull()
    expect(tos).not.toBeNull()
  })

  it('is false for a patient who has never accepted', async () => {
    expect(await hasAcceptedCurrentPolicies('RD-TESTPOLICY-NONE')).toBe(false)
  })

  it('is true only after recordPolicyAcceptance, and only for that patient', async () => {
    // Real seeded patient ids -- signatures.patient_id is a real FK to
    // patients.id, so a fabricated id would fail the insert, not the check.
    const acceptedPatient = 'RD-0001'
    const otherPatient = 'RD-0002'

    expect(await hasAcceptedCurrentPolicies(acceptedPatient)).toBe(false)
    await trackAcceptance(acceptedPatient)
    expect(await hasAcceptedCurrentPolicies(acceptedPatient)).toBe(true)

    // The bug this test guards against: signatures.signableId is the shared
    // policyDocuments row, not patient-specific -- without filtering by
    // patientId too, one patient's acceptance would incorrectly satisfy the
    // gate for every other patient.
    expect(await hasAcceptedCurrentPolicies(otherPatient)).toBe(false)
  })
})
