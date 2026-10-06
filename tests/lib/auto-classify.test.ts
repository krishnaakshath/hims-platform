import { describe, it, expect, afterEach } from 'vitest'
import { maybeAutoClassify } from '@/lib/auto-classify'
import { getDb } from '@/db/client'
import { appSettings, patients, diagnoses, medicationEpisodes, patientTrialScreenings, screeningCriteriaResults, auditLog } from '@/db/schema'
import { eq, and, gt } from 'drizzle-orm'

const TEST_SESSION = { role: 'crc' as const, name: 'Test Runner', userId: null }
const TEST_PATIENT_ID = 'RD-9001'

// appSettings is a single-row table, but its row's serial id is whatever the
// seed happened to assign it -- never assume it's 1 (re-seeding across a
// session increments the sequence). Always look the row up first.
async function setAutoClassify(value: boolean) {
  const [row] = await getDb().select().from(appSettings)
  await getDb().update(appSettings).set({ autoClassifyOnComplete: value }).where(eq(appSettings.id, row.id))
}

async function cleanup() {
  // regenerateScreeningCriteria (the real eligibility engine) replaces
  // whatever criteria rows exist with freshly generated ones carrying real
  // criterionKeys ('age-range', 'diagnosis', ...) -- filtering by a fixed
  // 'test-criterion' key here would miss those and leave FK-blocking rows
  // behind, so delete by screeningId instead.
  const screenings = await getDb().select({ id: patientTrialScreenings.id }).from(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, TEST_PATIENT_ID))
  for (const s of screenings) {
    await getDb().delete(screeningCriteriaResults).where(eq(screeningCriteriaResults.screeningId, s.id))
  }
  await getDb().delete(patientTrialScreenings).where(eq(patientTrialScreenings.patientId, TEST_PATIENT_ID))
  await getDb().delete(diagnoses).where(eq(diagnoses.patientId, TEST_PATIENT_ID))
  await getDb().delete(medicationEpisodes).where(eq(medicationEpisodes.patientId, TEST_PATIENT_ID))
  await getDb().delete(auditLog).where(and(eq(auditLog.patientId, TEST_PATIENT_ID), gt(auditLog.id, 0)))
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
}

afterEach(cleanup)

describe('maybeAutoClassify', () => {
  it('is a no-op when the setting is off', async () => {
    await setAutoClassify(false)
    await expect(maybeAutoClassify('RD-0001', TEST_SESSION)).resolves.toBeUndefined()
  })

  it('recomputes the verdict and logs an audit entry when the setting is on and preconditions are met', async () => {
    // Many sequential Neon HTTP round-trips (cleanup + inserts + the function
    // itself) comfortably exceed vitest's default 5s test timeout.
    await cleanup()
    await setAutoClassify(true)
    // A chart that genuinely satisfies every one of nct06911112's real
    // inclusion/exclusion criteria (see lib/eligibility.ts) -- age in range,
    // matching diagnosis, no exclusion diagnosis, stable on the required
    // antidepressant class well past its 56-day minimum, and a qualifying
    // PHQ-9 score -- so the real evaluator legitimately produces 'green',
    // proving maybeAutoClassify now recomputes from real data rather than
    // just re-aggregating whatever criteria rows already existed.
    await getDb().insert(patients).values({
      id: TEST_PATIENT_ID, name: 'Test Patient', dob: '1990-01-01',
      ratingScales: [{ name: 'PHQ-9', score: 15, date: '2026-08-01' }],
    })
    await getDb().insert(diagnoses).values({ patientId: TEST_PATIENT_ID, code: 'F33.1', description: 'Test diagnosis' })
    await getDb().insert(medicationEpisodes).values({ patientId: TEST_PATIENT_ID, name: 'Sertraline', medicationClass: 'SSRI/SNRI antidepressant', dose: '100mg daily', startDate: '2026-01-01', status: 'active' })
    const [screening] = await getDb().insert(patientTrialScreenings).values({ patientId: TEST_PATIENT_ID, trialId: 'nct06911112', overallStatus: 'yellow' }).returning()

    await maybeAutoClassify(TEST_PATIENT_ID, TEST_SESSION)

    const [updated] = await getDb().select().from(patientTrialScreenings).where(eq(patientTrialScreenings.id, screening.id))
    expect(updated.overallStatus).toBe('green')

    const auditEntries = await getDb().select().from(auditLog).where(eq(auditLog.patientId, TEST_PATIENT_ID))
    expect(auditEntries.some((e) => e.action.startsWith('auto-classified patient'))).toBe(true)

    await setAutoClassify(false)
  }, 15000)
})
