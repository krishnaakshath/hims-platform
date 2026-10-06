import { describe, it, expect, afterEach } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { charges } from '@/db/schema'
import { listPatientCollections } from '@/lib/queries/patient-collections'
import { getArDashboardData } from '@/lib/queries/ar-dashboard'
import { invalidateCache, patientCollectionsListCacheKey, arDashboardCacheKey } from '@/lib/cache'

// Both queries below cache for 30s (patient-collections) and 15s
// (ar-dashboard), so every read in this file invalidates both keys first --
// otherwise a read could return a value cached before this test's own
// mutation and silently pass or fail for the wrong reason.
async function refreshCaches() {
  await invalidateCache(patientCollectionsListCacheKey())
  await invalidateCache(arDashboardCacheKey())
}

async function patientBalanceCents(patientId: string): Promise<number> {
  const rows = await listPatientCollections()
  return rows.find((r) => r.patientId === patientId)?.balanceCents ?? 0
}

function chargeInput(patientId: string, amountCents: number, status: 'draft' | 'submitted') {
  return {
    patientId,
    providerName: 'Dr. R. Kunam',
    dateOfService: '2026-09-17',
    diagnosisCodes: [{ code: 'F33.1', description: 'MDD' }],
    procedureCodes: [{ code: '90837', description: 'Psychotherapy', units: 1, chargeCents: amountCents }],
    amountCents,
    status,
  }
}

// This suite exercises the real, shared dev database (not mocked), and the
// database is mutable and concurrently written by other branches/worktrees
// -- so every assertion here is a DELTA for one patient around this test's
// own insert, never an absolute total (same discipline as
// tests/lib/queries/ar-dashboard.test.ts's bucket-sum assertion). Every
// charge this file creates is tracked and deleted afterward.
const createdChargeIds: number[] = []

afterEach(async () => {
  if (createdChargeIds.length > 0) {
    await getDb().delete(charges).where(inArray(charges.id, createdChargeIds))
    createdChargeIds.length = 0
    await refreshCaches()
  }
})

describe('the draft-to-submitted charge lifecycle', () => {
  // listPatientCollections()/getArDashboardData() both aggregate across the
  // whole shared dev DB, and this test calls that pair four times (twice via
  // refreshCaches()'s callers) -- as the DB's data volume has grown, this
  // has crept right up against the global 15000ms default. A generous
  // override here, not a second global bump, since most tests aren't this
  // aggregate-heavy.
  it('leaves a draft charge out of patient collections and A/R, and counts it once submitted', { timeout: 30000 }, async () => {
    const patientId = 'RD-0002'
    await refreshCaches()
    const balanceBefore = await patientBalanceCents(patientId)
    const arBefore = (await getArDashboardData()).outstandingArCents

    const [draft] = await getDb().insert(charges).values(chargeInput(patientId, 12345, 'draft')).returning({ id: charges.id })
    createdChargeIds.push(draft.id)

    // A freshly created charge (including a pharmacy dispense charge) is
    // correctly invisible to A/R until billing submits it. Auto-submitting
    // it to make it appear sooner would be a regression, not a fix (spec
    // §6.2).
    await refreshCaches()
    expect(await patientBalanceCents(patientId)).toBe(balanceBefore)
    expect((await getArDashboardData()).outstandingArCents).toBe(arBefore)

    await getDb().update(charges).set({ status: 'submitted' }).where(eq(charges.id, draft.id))

    await refreshCaches()
    expect(await patientBalanceCents(patientId)).toBe(balanceBefore + 12345)
    expect((await getArDashboardData()).outstandingArCents).toBe(arBefore + 12345)
  })

  it('consolidates several submitted charges for one patient into a single row', async () => {
    // Pins that a pharmacy charge is just a charge: nothing in the read
    // path filters or groups on where a charge came from -- every
    // submitted charge for a patient folds into that patient's single
    // patient-collections row.
    const patientId = 'RD-0003'
    await refreshCaches()
    const balanceBefore = await patientBalanceCents(patientId)

    const [a] = await getDb().insert(charges).values(chargeInput(patientId, 10000, 'submitted')).returning({ id: charges.id })
    const [b] = await getDb().insert(charges).values(chargeInput(patientId, 20000, 'submitted')).returning({ id: charges.id })
    createdChargeIds.push(a.id, b.id)

    await refreshCaches()
    const rows = await listPatientCollections()
    const patientRows = rows.filter((r) => r.patientId === patientId)
    expect(patientRows).toHaveLength(1)
    expect(patientRows[0].balanceCents).toBe(balanceBefore + 30000)
  })
})
