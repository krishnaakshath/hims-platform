// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients, patientTrialScreenings, trials } from '@/db/schema'
import { getDashboardData } from '@/lib/queries/dashboard'

// Read straight through the loader: the shared Redis 'dashboard:data' entry
// (15s TTL, shared by every branch on this database) would otherwise hide the
// fixture rows this file creates.
vi.mock('@/lib/cache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cache')>()
  return { ...actual, getOrSetCache: async <T,>(_key: string, _ttl: number, loader: () => Promise<T>) => loader() }
})

const TEST_PATIENT_ID = 'RD-T17-TOTAL-PATIENTS'
const createdScreeningIds: number[] = []

afterEach(async () => {
  if (createdScreeningIds.length > 0) {
    await getDb().delete(patientTrialScreenings).where(inArray(patientTrialScreenings.id, createdScreeningIds.splice(0)))
  }
  await getDb().delete(patients).where(eq(patients.id, TEST_PATIENT_ID))
})

describe('getDashboardData', () => {
  it('returns all four widget datasets', async () => {
    const data = await getDashboardData()
    expect(data).toHaveProperty('latestForms')
    expect(data).toHaveProperty('pendingForms')
    expect(typeof data.pendingFormsTotal).toBe('number')
    expect(data).toHaveProperty('pendingClassification')
    expect(data).toHaveProperty('recentEvents')
  })

  it('totalPatients counts each patient once, even one screened for two trials', async () => {
    const before = (await getDashboardData()).totalPatients
    expect(typeof before).toBe('number')

    const twoTrials = await getDb().select({ id: trials.id }).from(trials).limit(2)
    expect(twoTrials).toHaveLength(2)
    await getDb().insert(patients).values({ id: TEST_PATIENT_ID, name: 'Task Seventeen Fixture', dob: '1980-01-01' })
    const screenings = await getDb().insert(patientTrialScreenings).values(
      twoTrials.map((t) => ({ patientId: TEST_PATIENT_ID, trialId: t.id, overallStatus: 'yellow' as const })),
    ).returning({ id: patientTrialScreenings.id })
    createdScreeningIds.push(...screenings.map((s) => s.id))

    const after = (await getDashboardData()).totalPatients
    expect(after - before).toBe(1)
  })
})
