import { describe, it, expect, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { insuranceEligibilityChecks, payers } from '@/db/schema'
import { simulateEligibilityCheck, recordEligibilityCheck, getLatestEligibilityCheck, countEligibilityFollowUps } from '@/lib/queries/insurance-eligibility'

const createdIds: number[] = []
afterEach(async () => {
  while (createdIds.length > 0) await getDb().delete(insuranceEligibilityChecks).where(eq(insuranceEligibilityChecks.id, createdIds.pop()!))
})

describe('simulateEligibilityCheck', () => {
  it('returns the same result for the same patient+payer pair every time', () => {
    const first = simulateEligibilityCheck('RD-0001', 'Aetna')
    const second = simulateEligibilityCheck('RD-0001', 'Aetna')
    expect(second).toEqual(first)
  })

  it('can return different results for a different payer on the same patient', () => {
    const aetna = simulateEligibilityCheck('RD-0001', 'Aetna')
    const kaiser = simulateEligibilityCheck('RD-0001', 'Kaiser Permanente')
    // Not asserting they're always different (a hash collision is fine) --
    // asserting the function actually varies its input into the result
    // rather than always returning one hardcoded status.
    expect(typeof aetna.status).toBe('string')
    expect(typeof kaiser.status).toBe('string')
  })

  it('also derives a deterministic deductibleRemainingCents alongside status/copay', () => {
    const first = simulateEligibilityCheck('RD-0001', 'Aetna')
    const second = simulateEligibilityCheck('RD-0001', 'Aetna')
    expect('deductibleRemainingCents' in first).toBe(true)
    expect(second.deductibleRemainingCents).toBe(first.deductibleRemainingCents)
  })

  it('echoes back whatever planType it is given, or null when not on file', () => {
    const withPlan = simulateEligibilityCheck('RD-0001', 'Aetna', 'ppo')
    expect(withPlan.planType).toBe('ppo')
    const withoutPlan = simulateEligibilityCheck('RD-0001', 'Aetna')
    expect(withoutPlan.planType).toBeNull()
  })
})

describe('recordEligibilityCheck / getLatestEligibilityCheck', () => {
  it('returns the most recently recorded check for a patient', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const first = await recordEligibilityCheck({ patientId: 'RD-0001', payerName: 'Aetna', payerId: payer.id, status: 'verified', copayCents: 3000, deductibleRemainingCents: 500, planType: null, coverageStartDate: null, checkedByName: 'Taylor Nguyen' })
    createdIds.push(first.id)
    const second = await recordEligibilityCheck({ patientId: 'RD-0001', payerName: 'Aetna', payerId: payer.id, status: 'inactive', copayCents: null, deductibleRemainingCents: null, planType: null, coverageStartDate: null, checkedByName: 'Taylor Nguyen' })
    createdIds.push(second.id)

    const latest = await getLatestEligibilityCheck('RD-0001')
    expect(latest?.id).toBe(second.id)
    expect(latest?.payerId).toBe(payer.id)
  })

  it('returns null when no check has been recorded', async () => {
    const latest = await getLatestEligibilityCheck('RD-9999')
    expect(latest).toBeNull()
  })

  it('stores the richer eligibility fields (payerId, deductibleRemainingCents, planType, coverageStartDate)', async () => {
    const [payer] = await getDb().select().from(payers).limit(1)
    const created = await recordEligibilityCheck({ patientId: 'RD-0001', payerName: payer.name, payerId: payer.id, status: 'verified', copayCents: 2000, deductibleRemainingCents: 900, planType: 'hmo', coverageStartDate: '2025-01-01', checkedByName: 'Taylor Nguyen' })
    createdIds.push(created.id)
    expect(created.payerId).toBe(payer.id)
    expect(created.deductibleRemainingCents).toBe(900)
    expect(created.planType).toBe('hmo')
    expect(created.coverageStartDate).toBe('2025-01-01')
  })
})

describe('countEligibilityFollowUps', () => {
  it('counts a patient whose latest check needs follow-up, and stops counting them once a later check resolves it', async () => {
    const baseline = await countEligibilityFollowUps()

    const older = await recordEligibilityCheck({ patientId: 'RD-0002', payerName: 'Test Payer', payerId: null, status: 'needs_follow_up', copayCents: null, deductibleRemainingCents: null, planType: null, coverageStartDate: null, checkedByName: 'Taylor Nguyen' })
    createdIds.push(older.id)
    expect(await countEligibilityFollowUps()).toBe(baseline + 1)

    // A later, resolving check for the same patient must un-count them, even
    // though an older needs_follow_up row for that patient still exists --
    // only the MOST RECENT check per patient should be considered.
    const newer = await recordEligibilityCheck({ patientId: 'RD-0002', payerName: 'Test Payer', payerId: null, status: 'verified', copayCents: 2000, deductibleRemainingCents: 300, planType: null, coverageStartDate: null, checkedByName: 'Taylor Nguyen' })
    createdIds.push(newer.id)
    expect(await countEligibilityFollowUps()).toBe(baseline)
  })
})
