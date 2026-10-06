import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medicationEpisodes } from '@/db/schema'
import { medicationEpisodeToFhir, medicationEpisodesToFhir } from '@/lib/fhir/medication-request'

const createdEpisodeIds: number[] = []
afterEach(async () => {
  while (createdEpisodeIds.length > 0) await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.id, createdEpisodeIds.pop()!))
})

// Column drift note (see task-2/task-3 briefs): the live shared DB's
// `patients` table has been migrated by a concurrent worktree to
// single-sourced name/dob/etc columns, dropping the dual-sourced
// Tebra/IntakeQ columns this worktree's schema.ts still declares. An
// `insert(patients)` here would 500 regardless of which columns are set,
// since drizzle's insert lists every declared column. These tests only
// need a valid `patients.id` to satisfy `medicationEpisodes.patientId`'s FK,
// so they reuse a seeded patient (scoped `id`-only select, the established
// pattern -- e.g. tests/db/prescriptions-schema.test.ts) instead of
// inserting a new one.
let patientId: string
beforeAll(async () => {
  const [patient] = await getDb().select({ id: patients.id }).from(patients).limit(1)
  patientId = patient.id
})

describe('medicationEpisodeToFhir', () => {
  it('maps an active episode to a MedicationRequest', async () => {
    const [activeRow] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Sertraline', medicationClass: 'SSRI', dose: '100mg daily', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(activeRow.id)

    const fhir = medicationEpisodeToFhir(activeRow)
    expect(fhir).not.toBeNull()
    expect(fhir!.resourceType).toBe('MedicationRequest')
    expect(fhir!.status).toBe('active')
    expect(fhir!.subject).toEqual({ reference: `Patient/${patientId}` })
    expect(fhir!.medicationCodeableConcept).toEqual({ text: 'Sertraline (SSRI)' })
    expect(fhir!.dosageInstruction).toEqual([{ text: '100mg daily' }])
    expect(fhir!.authoredOn).toBe('2026-01-01')
  })

  it('returns null for an inactive episode', async () => {
    const [inactiveRow] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Fluoxetine', medicationClass: 'SSRI', dose: '20mg daily',
      startDate: '2025-06-01', stopDate: '2025-12-01', status: 'inactive',
    }).returning()
    createdEpisodeIds.push(inactiveRow.id)

    expect(medicationEpisodeToFhir(inactiveRow)).toBeNull()
  })

  it('omits dosageInstruction entirely when dose is null', async () => {
    const [row] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Bupropion', medicationClass: 'NDRI', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(row.id)

    const fhir = medicationEpisodeToFhir(row)
    expect(fhir!.dosageInstruction).toBeUndefined()
  })

  it('medicationEpisodesToFhir filters out inactive episodes', async () => {
    const [activeRow] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Sertraline', medicationClass: 'SSRI', dose: '100mg daily', startDate: '2026-01-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(activeRow.id)
    const [inactiveRow] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Fluoxetine', medicationClass: 'SSRI', dose: '20mg daily',
      startDate: '2025-06-01', stopDate: '2025-12-01', status: 'inactive',
    }).returning()
    createdEpisodeIds.push(inactiveRow.id)

    const fhirList = medicationEpisodesToFhir([activeRow, inactiveRow])
    expect(fhirList).toHaveLength(1)
    expect(fhirList[0].medicationCodeableConcept).toEqual({ text: 'Sertraline (SSRI)' })
  })

  it('composes the full sig into dosageInstruction[0].text for a prescribed row', async () => {
    const [row] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Sertraline', medicationClass: 'SSRI', startDate: '2026-06-01', status: 'active',
      dose: '50mg', frequencyPerDay: 2, durationDays: 30, instructions: 'Take with food.', prescribedAt: new Date(),
    }).returning()
    createdEpisodeIds.push(row.id)

    const fhir = medicationEpisodeToFhir(row)
    const text = fhir!.dosageInstruction![0].text
    expect(text).toContain('50mg')
    expect(text).toContain('2 times daily')
    expect(text).toContain('30 days')
    expect(text).toContain('Take with food.')
  })

  it("sets authoredOn to prescribedAt's date, not startDate, for a prescribed row", async () => {
    const [row] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Sertraline', medicationClass: 'SSRI', startDate: '2026-06-01', status: 'active',
      prescribedAt: new Date('2026-09-29T17:04:00Z'),
    }).returning()
    createdEpisodeIds.push(row.id)

    const fhir = medicationEpisodeToFhir(row)
    expect(fhir!.authoredOn).toBe('2026-09-29')
  })

  it('leaves an imported row (all seven new columns null) unchanged, byte for byte', async () => {
    const [withDose] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Imported Med', medicationClass: 'Test Class', startDate: '2025-06-01', status: 'active',
      dose: '10mg',
    }).returning()
    createdEpisodeIds.push(withDose.id)

    const fhirWithDose = medicationEpisodeToFhir(withDose)
    expect(fhirWithDose!.dosageInstruction).toEqual([{ text: '10mg' }])
    expect(fhirWithDose!.authoredOn).toBe('2025-06-01')

    const [withoutDose] = await getDb().insert(medicationEpisodes).values({
      patientId, name: 'Imported Med 2', medicationClass: 'Test Class', startDate: '2025-06-01', status: 'active',
    }).returning()
    createdEpisodeIds.push(withoutDose.id)

    const fhirWithoutDose = medicationEpisodeToFhir(withoutDose)
    expect('dosageInstruction' in fhirWithoutDose!).toBe(false)
  })
})
