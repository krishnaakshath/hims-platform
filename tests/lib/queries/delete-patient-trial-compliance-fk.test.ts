import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, trials, adverseEvents, drugAccountabilityEntries, signatures } from '@/db/schema'
import { deletePatient } from '@/lib/queries/patients'

// Regression test for the FK-coverage gap tests/lib/queries/delete-patient-fk-guard.test.ts
// caught: adverse_events.patient_id (NOT NULL), drug_accountability_entries.patient_id
// (nullable), and signatures.patient_id (nullable, policy_acceptance only) are all
// FKs to patients(id) with no ON DELETE action, added by the trial-compliance and
// policy-acceptance features after deletePatient()'s cascade was last audited.
// Matches the shape of delete-patient-care-plans.test.ts.
describe('deletePatient — trial compliance and signature cleanup', () => {
  it('deletes adverse events, drug accountability entries, and signatures for the patient, and does not leave an FK violation', { timeout: 30000 }, async () => {
    const db = getDb()
    const testPatientId = `TEST-DEL-TC-${Date.now()}`
    await db.insert(patients).values({ id: testPatientId, name: 'Delete Trial Compliance Test Patient', dob: '2000-01-01' })
    const [trial] = await db.select({ id: trials.id }).from(trials).limit(1)

    const [ae] = await db.insert(adverseEvents).values({
      trialId: trial.id,
      patientId: testPatientId,
      description: 'Test adverse event',
      severity: 'mild',
      causality: 'unrelated',
      onsetDate: '2026-01-01',
      reportedDate: '2026-01-01',
      reportedByName: 'Dr. Test',
    }).returning()

    const [dae] = await db.insert(drugAccountabilityEntries).values({
      trialId: trial.id,
      patientId: testPatientId,
      lotNumber: 'LOT-TEST-1',
      expirationDate: '2027-01-01',
      action: 'dispensed',
      quantity: 1,
      performedByName: 'Dr. Test',
      date: '2026-01-01',
    }).returning()

    const [sig] = await db.insert(signatures).values({
      signableType: 'policy_acceptance',
      signableId: 1,
      patientId: testPatientId,
      signerTypedName: 'Test Patient',
      signerRole: 'patient',
      attestationText: 'Test attestation',
    }).returning()

    const deleted = await deletePatient(testPatientId)
    expect(deleted).toBe(true)

    expect((await db.select().from(adverseEvents).where(eq(adverseEvents.id, ae.id))).length).toBe(0)
    expect((await db.select().from(drugAccountabilityEntries).where(eq(drugAccountabilityEntries.id, dae.id))).length).toBe(0)
    expect((await db.select().from(signatures).where(eq(signatures.id, sig.id))).length).toBe(0)
  })
})
