import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, providers, allergies, diagnoses, medicationEpisodes, labTests, labOrders, labResults } from '@/db/schema'
import { gatherPatientFhirData, type PatientFhirData } from '@/lib/fhir/gather'
import { toCcdaXml } from '@/lib/fhir/ccda'
import { buildFullBundle } from '@/lib/fhir/bundle'
import type { FhirAllergyIntolerance } from '@/lib/fhir/allergy'
import type { FhirCondition } from '@/lib/fhir/condition'
import type { FhirObservation } from '@/lib/fhir/observation'

let data: PatientFhirData
let patientId: string
let emptyPatientData: PatientFhirData
let emptyPatientId: string
let allergyId: number
let diagnosisId: number
let episodeId: number
let testId: number
let orderId: number

beforeAll(async () => {
  const db = getDb()

  const [emptyPatient] = await db.insert(patients).values({
    id: 'RD-FHIR-CCDA-EMPTY', name: 'CCDA Empty Patient', dob: '1990-01-01',
  }).returning()
  emptyPatientId = emptyPatient.id
  emptyPatientData = (await gatherPatientFhirData(emptyPatientId))!

  const [patient] = await db.insert(patients).values({
    id: 'RD-FHIR-CCDA-1', name: 'CCDA Patient', dob: '1980-01-01',
  }).returning()
  patientId = patient.id

  const [providerRow] = await db.select().from(providers).limit(1)

  const [allergyRow] = await db.insert(allergies).values({
    patientId, allergen: 'Penicillin', reaction: 'Hives', severity: 'moderate',
  }).returning()
  allergyId = allergyRow.id

  const [diagnosisRow] = await db.insert(diagnoses).values({
    patientId, code: 'J45.909', description: 'Asthma, unspecified', date: '2024-01-01',
  }).returning()
  diagnosisId = diagnosisRow.id

  const [episodeRow] = await db.insert(medicationEpisodes).values({
    patientId, name: 'Sertraline', medicationClass: 'SSRI', dose: '100mg daily', startDate: '2026-01-01', status: 'active',
  }).returning()
  episodeId = episodeRow.id

  const [test] = await db.insert(labTests).values({
    name: 'Thyroid Stimulating Hormone', code: 'TSH', defaultUnit: 'mIU/L', referenceRange: '0.4-4.0',
  }).returning()
  testId = test.id

  const [order] = await db.insert(labOrders).values({
    patientId, labTestId: test.id, orderedByProviderId: providerRow.id, status: 'resulted',
  }).returning()
  orderId = order.id

  await db.insert(labResults).values({
    labOrderId: order.id, value: '2.5', unit: 'mIU/L', flag: 'normal', resultedByName: 'Test Staff',
  })

  data = (await gatherPatientFhirData(patientId))!
})

afterAll(async () => {
  const db = getDb()
  await db.delete(labResults).where(eq(labResults.labOrderId, orderId))
  await db.delete(labOrders).where(eq(labOrders.id, orderId))
  await db.delete(labTests).where(eq(labTests.id, testId))
  await db.delete(medicationEpisodes).where(eq(medicationEpisodes.id, episodeId))
  await db.delete(diagnoses).where(eq(diagnoses.id, diagnosisId))
  await db.delete(allergies).where(eq(allergies.id, allergyId))
  await db.delete(patients).where(eq(patients.id, patientId))
  await db.delete(patients).where(eq(patients.id, emptyPatientId))
})

describe('toCcdaXml', () => {
  it('produces well-formed XML', () => {
    const xml = toCcdaXml(data)
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    expect(parsed.getElementsByTagName('parsererror').length).toBe(0)
  })

  it('produces a well-formed, empty-but-valid document for a patient with no allergies/conditions/medications/labs', () => {
    const xml = toCcdaXml(emptyPatientData)
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    expect(parsed.getElementsByTagName('parsererror').length).toBe(0)
    // Every section still renders (empty, not omitted or erroring).
    expect(xml).toContain('<title>Allergies</title>')
    expect(xml).toContain('<title>Active Medications</title>')
    expect(xml).toContain('<title>Problems</title>')
    expect(xml).toContain('<title>Results</title>')
  })

  it('escapes XML special characters in patient data', () => {
    const xml = toCcdaXml({ ...data, allergyRows: [{ ...data.allergyRows[0], allergen: 'Penicillin & "shellfish" <severe>' }] })
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    expect(parsed.getElementsByTagName('parsererror').length).toBe(0)
    expect(xml).toContain('Penicillin &amp; &quot;shellfish&quot; &lt;severe&gt;')
  })

  it('reflects the same facts as the FHIR Bundle for the same patient', () => {
    const bundle = buildFullBundle(data)
    const xml = toCcdaXml(data)

    const allergyResource = bundle.entry.map((e) => e.resource).find((r): r is FhirAllergyIntolerance => (r as { resourceType: string }).resourceType === 'AllergyIntolerance')
    expect(xml).toContain(allergyResource!.code.text) // the allergen text appears in both formats

    const conditionResource = bundle.entry.map((e) => e.resource).find((r): r is FhirCondition => (r as { resourceType: string }).resourceType === 'Condition')
    expect(xml).toContain(conditionResource!.code.text!) // the diagnosis description appears in both formats

    const observationResource = bundle.entry.map((e) => e.resource).find((r): r is FhirObservation => (r as { resourceType: string }).resourceType === 'Observation')
    const observedValue = 'valueQuantity' in observationResource! ? String(observationResource.valueQuantity!.value) : observationResource!.valueString!
    expect(xml).toContain(observedValue) // the lab value appears in both formats
  })
})
