// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, medicationEpisodes } from '@/db/schema'
import { findLikelyDuplicatePatients, listPharmacyPatientRoster } from '@/lib/queries/patients'

// findLikelyDuplicatePatients used to check both the Tebra- and
// IntakeQ-sourced name/dob column pairs (pre-unified-patient-record). These
// fixtures confirm it now reads the single `name`/`dob` columns correctly.
const TEST_ID_A = 'RD-DUP-TEST-A'
const TEST_ID_B = 'RD-DUP-TEST-B'

beforeAll(async () => {
  await getDb().insert(patients).values([
    { id: TEST_ID_A, name: 'Jordan Rivera', dob: '1988-04-12' },
    { id: TEST_ID_B, name: 'Jordan Rivera-Smith', dob: '1988-04-12' },
  ])
})

afterAll(async () => {
  await getDb().delete(patients).where(eq(patients.id, TEST_ID_A))
  await getDb().delete(patients).where(eq(patients.id, TEST_ID_B))
})

describe('listPharmacyPatientRoster', () => {
  const ROSTER_ACTIVE_ID = 'RD-ROSTER-TEST-ACTIVE'
  const ROSTER_INACTIVE_ID = 'RD-ROSTER-TEST-INACTIVE'

  beforeAll(async () => {
    await getDb().insert(patients).values([
      { id: ROSTER_ACTIVE_ID, name: 'Roster Test Active', dob: '1990-01-01', currentProvider: 'Dr. Roster Test' },
      { id: ROSTER_INACTIVE_ID, name: 'Roster Test Inactive', dob: '1990-01-01' },
    ])
    await getDb().insert(medicationEpisodes).values([
      { patientId: ROSTER_ACTIVE_ID, name: 'Sertraline', medicationClass: 'SSRI', dose: '50mg daily', startDate: '2026-01-01', status: 'active' },
      { patientId: ROSTER_ACTIVE_ID, name: 'Trazodone', medicationClass: 'Atypical antidepressant', dose: '50mg at bedtime', startDate: '2026-01-01', status: 'active' },
      { patientId: ROSTER_INACTIVE_ID, name: 'Bupropion', medicationClass: 'Atypical antidepressant', dose: '150mg daily', startDate: '2025-01-01', stopDate: '2025-06-01', status: 'inactive' },
    ])
  })

  afterAll(async () => {
    await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.patientId, ROSTER_ACTIVE_ID))
    await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.patientId, ROSTER_INACTIVE_ID))
    await getDb().delete(patients).where(eq(patients.id, ROSTER_ACTIVE_ID))
    await getDb().delete(patients).where(eq(patients.id, ROSTER_INACTIVE_ID))
  })

  it('includes a patient with an active medication episode, with the correct active count', async () => {
    const roster = await listPharmacyPatientRoster()
    const row = roster.find((r) => r.id === ROSTER_ACTIVE_ID)
    expect(row).toBeDefined()
    expect(row?.name).toBe('Roster Test Active')
    expect(row?.currentProvider).toBe('Dr. Roster Test')
    expect(row?.activeMedicationCount).toBe(2)
  })

  it('excludes a patient whose only medication episodes are inactive', async () => {
    const roster = await listPharmacyPatientRoster()
    expect(roster.some((r) => r.id === ROSTER_INACTIVE_ID)).toBe(false)
  })
})

describe('findLikelyDuplicatePatients', () => {
  it('matches rows sharing the same dob and an overlapping (substring) name', async () => {
    const matches = await findLikelyDuplicatePatients('Jordan Rivera', '1988-04-12')
    const ids = matches.map((m) => m.id)
    expect(ids).toContain(TEST_ID_A)
    expect(ids).toContain(TEST_ID_B)

    const a = matches.find((m) => m.id === TEST_ID_A)
    expect(a?.name).toBe('Jordan Rivera')
    expect(a?.dob).toBe('1988-04-12')
  })

  it('excludes rows with a matching dob but no name overlap', async () => {
    const matches = await findLikelyDuplicatePatients('Completely Different Name', '1988-04-12')
    const ids = matches.map((m) => m.id)
    expect(ids).not.toContain(TEST_ID_A)
    expect(ids).not.toContain(TEST_ID_B)
  })

  it('excludes rows with a matching name but a different dob', async () => {
    const matches = await findLikelyDuplicatePatients('Jordan Rivera', '1975-01-01')
    const ids = matches.map((m) => m.id)
    expect(ids).not.toContain(TEST_ID_A)
    expect(ids).not.toContain(TEST_ID_B)
  })
})
