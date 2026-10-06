import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, labTests, labOrders, labResults } from '@/db/schema'
import { listOrdersForPatient } from '@/lib/queries/lab-orders'
import { observationsToFhir } from '@/lib/fhir/observation'

const createdPatientIds: string[] = []
const createdTestIds: number[] = []
const createdOrderIds: number[] = []
afterEach(async () => {
  while (createdOrderIds.length > 0) {
    const id = createdOrderIds.pop()!
    await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
    await getDb().delete(labOrders).where(eq(labOrders.id, id))
  }
  while (createdTestIds.length > 0) await getDb().delete(labTests).where(eq(labTests.id, createdTestIds.pop()!))
  while (createdPatientIds.length > 0) await getDb().delete(patients).where(eq(patients.id, createdPatientIds.pop()!))
})

describe('observationsToFhir', () => {
  it('maps resulted orders to Observations and drops still-ordered rows with no result', async () => {
    const db = getDb()
    const [patient] = await db.insert(patients).values({
      id: 'RD-FHIR-O1', name: 'Obs Patient', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)
    const [providerRow] = await db.select().from(providers).limit(1)

    // Numeric resulted lab.
    const [tshTest] = await db.insert(labTests).values({ name: 'Thyroid Stimulating Hormone', code: 'TSH', defaultUnit: 'mIU/L', referenceRange: '0.4-4.0' }).returning()
    createdTestIds.push(tshTest.id)
    const [tshOrder] = await db.insert(labOrders).values({ patientId: patient.id, labTestId: tshTest.id, orderedByProviderId: providerRow.id, status: 'resulted' }).returning()
    createdOrderIds.push(tshOrder.id)
    await db.insert(labResults).values({ labOrderId: tshOrder.id, value: '2.5', unit: 'mIU/L', flag: 'normal', resultedByName: 'Test Staff' })

    // Non-numeric resulted lab.
    const [udsTest] = await db.insert(labTests).values({ name: 'Urine Drug Screen', code: 'UDS' }).returning()
    createdTestIds.push(udsTest.id)
    const [udsOrder] = await db.insert(labOrders).values({ patientId: patient.id, labTestId: udsTest.id, orderedByProviderId: providerRow.id, status: 'resulted' }).returning()
    createdOrderIds.push(udsOrder.id)
    await db.insert(labResults).values({ labOrderId: udsOrder.id, value: 'Negative', unit: null, flag: 'normal', resultedByName: 'Test Staff' })

    // Still-ordered lab, no result row at all.
    const [pendingTest] = await db.insert(labTests).values({ name: 'Complete Blood Count', code: 'CBC' }).returning()
    createdTestIds.push(pendingTest.id)
    const [pendingOrder] = await db.insert(labOrders).values({ patientId: patient.id, labTestId: pendingTest.id, orderedByProviderId: providerRow.id }).returning()
    createdOrderIds.push(pendingOrder.id)

    const orders = await listOrdersForPatient(patient.id)
    const fhirList = observationsToFhir(patient.id, orders)

    expect(fhirList).toHaveLength(2)

    const tshFhir = fhirList.find((o) => o.id === `observation-${tshOrder.id}`)!
    expect(tshFhir.resourceType).toBe('Observation')
    expect(tshFhir.status).toBe('final')
    expect(tshFhir.subject).toEqual({ reference: `Patient/${patient.id}` })
    expect(tshFhir.code.coding).toEqual([{ code: 'TSH', display: 'Thyroid Stimulating Hormone' }])
    expect(tshFhir.valueQuantity).toEqual({ value: 2.5, unit: 'mIU/L' })
    expect(tshFhir).not.toHaveProperty('valueString')
    expect(tshFhir.interpretation).toEqual([{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'N' }] }])

    const udsFhir = fhirList.find((o) => o.id === `observation-${udsOrder.id}`)!
    expect(udsFhir.valueString).toBe('Negative')
    expect(udsFhir).not.toHaveProperty('valueQuantity')
    expect(JSON.stringify(udsFhir)).not.toContain('NaN')
    expect(udsFhir.code.coding).toEqual([{ code: 'UDS', display: 'Urine Drug Screen' }])
  })

  it('maps abnormal and critical flags to A and AA interpretation codes', async () => {
    const db = getDb()
    const [patient] = await db.insert(patients).values({
      id: 'RD-FHIR-O2', name: 'Obs Patient 2', dob: '1980-01-01',
    }).returning()
    createdPatientIds.push(patient.id)
    const [providerRow] = await db.select().from(providers).limit(1)

    const [abnormalTest] = await db.insert(labTests).values({ name: 'Potassium', code: 'K' }).returning()
    createdTestIds.push(abnormalTest.id)
    const [abnormalOrder] = await db.insert(labOrders).values({ patientId: patient.id, labTestId: abnormalTest.id, orderedByProviderId: providerRow.id, status: 'resulted' }).returning()
    createdOrderIds.push(abnormalOrder.id)
    await db.insert(labResults).values({ labOrderId: abnormalOrder.id, value: '5.8', unit: 'mmol/L', flag: 'abnormal', resultedByName: 'Test Staff' })

    const [criticalTest] = await db.insert(labTests).values({ name: 'Glucose', code: 'GLU' }).returning()
    createdTestIds.push(criticalTest.id)
    const [criticalOrder] = await db.insert(labOrders).values({ patientId: patient.id, labTestId: criticalTest.id, orderedByProviderId: providerRow.id, status: 'resulted' }).returning()
    createdOrderIds.push(criticalOrder.id)
    await db.insert(labResults).values({ labOrderId: criticalOrder.id, value: '400', unit: 'mg/dL', flag: 'critical', resultedByName: 'Test Staff' })

    const orders = await listOrdersForPatient(patient.id)
    const fhirList = observationsToFhir(patient.id, orders)

    const abnormalFhir = fhirList.find((o) => o.id === `observation-${abnormalOrder.id}`)!
    expect(abnormalFhir.interpretation).toEqual([{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'A' }] }])

    const criticalFhir = fhirList.find((o) => o.id === `observation-${criticalOrder.id}`)!
    expect(criticalFhir.interpretation).toEqual([{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'AA' }] }])
  })
})
