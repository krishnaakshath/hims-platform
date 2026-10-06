// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, adverseEvents, drugAccountabilityEntries, regulatoryDocuments } from '@/db/schema'
import {
  listAdverseEvents, createAdverseEvent, markAdverseEventNotified,
  listDrugAccountability, createDrugAccountabilityEntry, drugOnHand,
  listRegulatoryDocuments, createRegulatoryDocument,
} from '@/lib/queries/trial-compliance'

const TRIAL_ID = 'nct06911112'
const TEST_PATIENT_ID = 'RD-COMPLIANCE-TEST-01'

beforeAll(async () => {
  await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Compliance Test Patient', dob: '1990-01-01' })
})

afterAll(async () => {
  await getDb().delete(adverseEvents).where(eq(adverseEvents.patientId, TEST_PATIENT_ID))
  await getDb().delete(drugAccountabilityEntries).where(eq(drugAccountabilityEntries.patientId, TEST_PATIENT_ID))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

describe('adverse events', () => {
  it('creates an event and lists it with the patient name joined in', async () => {
    const created = await createAdverseEvent({
      trialId: TRIAL_ID, patientId: TEST_PATIENT_ID, description: 'Test headache',
      severity: 'mild', serious: false, causality: 'unlikely', onsetDate: '2026-09-01', reportedDate: '2026-09-02', reportedByName: 'Test Coordinator',
    })
    const events = await listAdverseEvents(TRIAL_ID)
    const row = events.find((e) => e.id === created.id)
    expect(row).toBeDefined()
    expect(row?.patientName).toBe('Compliance Test Patient')
    expect(row?.sponsorNotifiedAt).toBeNull()
  })

  it('marks sponsor and IRB notification separately', async () => {
    const created = await createAdverseEvent({
      trialId: TRIAL_ID, patientId: TEST_PATIENT_ID, description: 'Test SAE',
      severity: 'severe', serious: true, causality: 'possibly', onsetDate: '2026-09-05', reportedDate: '2026-09-05', reportedByName: 'Test Coordinator',
    })
    await markAdverseEventNotified(created.id, 'sponsor')
    let events = await listAdverseEvents(TRIAL_ID)
    let row = events.find((e) => e.id === created.id)
    expect(row?.sponsorNotifiedAt).not.toBeNull()
    expect(row?.irbNotifiedAt).toBeNull()

    await markAdverseEventNotified(created.id, 'irb')
    events = await listAdverseEvents(TRIAL_ID)
    row = events.find((e) => e.id === created.id)
    expect(row?.irbNotifiedAt).not.toBeNull()
  })
})

describe('drug accountability', () => {
  it('computes on-hand as received + returned - dispensed - destroyed', async () => {
    await createDrugAccountabilityEntry({ trialId: TRIAL_ID, patientId: null, lotNumber: 'TEST-LOT-01', expirationDate: '2027-01-01', action: 'received', quantity: 100, performedByName: 'Test Coordinator', date: '2026-09-01' })
    await createDrugAccountabilityEntry({ trialId: TRIAL_ID, patientId: TEST_PATIENT_ID, lotNumber: 'TEST-LOT-01', expirationDate: '2027-01-01', action: 'dispensed', quantity: 30, performedByName: 'Test Coordinator', date: '2026-09-02' })
    await createDrugAccountabilityEntry({ trialId: TRIAL_ID, patientId: TEST_PATIENT_ID, lotNumber: 'TEST-LOT-01', expirationDate: '2027-01-01', action: 'returned', quantity: 5, performedByName: 'Test Coordinator', date: '2026-09-10' })
    await createDrugAccountabilityEntry({ trialId: TRIAL_ID, patientId: null, lotNumber: 'TEST-LOT-01', expirationDate: '2027-01-01', action: 'destroyed', quantity: 5, performedByName: 'Test Coordinator', date: '2026-09-11' })

    const entries = (await listDrugAccountability(TRIAL_ID)).filter((e) => e.lotNumber === 'TEST-LOT-01')
    expect(drugOnHand(entries)).toBe(100 + 5 - 30 - 5)

    await getDb().delete(drugAccountabilityEntries).where(eq(drugAccountabilityEntries.lotNumber, 'TEST-LOT-01'))
  })
})

describe('regulatory documents', () => {
  it('creates and lists a document defaulting to current status', async () => {
    const created = await createRegulatoryDocument({
      trialId: TRIAL_ID, documentType: 'irb_approval', title: 'Test IRB Approval',
      effectiveDate: '2026-01-01', expirationDate: '2027-01-01', uploadedByName: 'Test Coordinator',
    })
    const docs = await listRegulatoryDocuments(TRIAL_ID)
    const row = docs.find((d) => d.id === created.id)
    expect(row).toBeDefined()
    expect(row?.status).toBe('current')
    expect(row?.title).toBe('Test IRB Approval')

    await getDb().delete(regulatoryDocuments).where(eq(regulatoryDocuments.id, created.id))
  })
})
