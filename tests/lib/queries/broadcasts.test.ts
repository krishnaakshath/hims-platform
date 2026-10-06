import { describe, it, expect } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patientTrialScreenings } from '@/db/schema'
import { listBroadcastRecipientCandidates, simulateBroadcastDelivery, listBroadcasts } from '@/lib/queries/broadcasts'

describe('simulateBroadcastDelivery', () => {
  it('delivers SMS only when a phone number is on file', () => {
    expect(simulateBroadcastDelivery('sms', '909-555-0142', null)).toBe('delivered')
    expect(simulateBroadcastDelivery('sms', null, 'a@example.com')).toBe('failed')
  })

  it('delivers email only when an email address is on file', () => {
    expect(simulateBroadcastDelivery('email', null, 'a@example.com')).toBe('delivered')
    expect(simulateBroadcastDelivery('email', '909-555-0142', null)).toBe('failed')
  })

  it('delivers "both" when at least one contact method is on file', () => {
    expect(simulateBroadcastDelivery('both', null, 'a@example.com')).toBe('delivered')
    expect(simulateBroadcastDelivery('both', null, null)).toBe('failed')
  })
})

describe('listBroadcastRecipientCandidates', () => {
  it('filters by trial', async () => {
    const candidates = await listBroadcastRecipientCandidates({ trialId: 'nct06911112' })
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.every((c) => typeof c.id === 'string')).toBe(true)
  })

  it('filters by overall status', async () => {
    const candidates = await listBroadcastRecipientCandidates({ overallStatus: 'red' })
    expect(candidates.length).toBeGreaterThan(0)
  })

  it('returns patients with no form submission at all when formStatus is "none"', async () => {
    const candidates = await listBroadcastRecipientCandidates({ formStatus: 'none' })
    // Seeded filler patients (RD-0007+) never get a form submission — see Phase 1's seed.
    expect(candidates.some((c) => c.id === 'RD-0007')).toBe(true)
  })

  it('resolves a multi-screening patient deterministically (latest screening row wins), not by arbitrary row order', async () => {
    const db = getDb()
    // RD-0001 already has one seeded screening row (nct06911112, not 'red').
    // Insert a second, newer 'red' screening row for a different trial so
    // this patient now has 2 screening rows -- the exact "multi-trial
    // patient" case the function's own comment flags as undefined-order
    // today. BroadcastRecipientCandidate does not expose overallStatus
    // (public return shape is id/name/phone/email only, per this task's "no
    // interface change" constraint), so determinism is observed indirectly:
    // filtering by overallStatus: 'red' either includes RD-0001 (the newest
    // screening won) or excludes it (the older seeded screening won) --
    // that inclusion must be the same on every call.
    const [secondScreening] = await db.insert(patientTrialScreenings).values({
      patientId: 'RD-0001',
      trialId: 'nct-adhd-demo-01',
      overallStatus: 'red',
    }).returning()

    try {
      const firstRedIds = (await listBroadcastRecipientCandidates({ overallStatus: 'red' })).map((c) => c.id)
      const secondRedIds = (await listBroadcastRecipientCandidates({ overallStatus: 'red' })).map((c) => c.id)
      expect(firstRedIds.includes('RD-0001')).toBe(secondRedIds.includes('RD-0001'))
      // The real product decision this fix makes explicit: the most
      // recently created screening wins, so the just-inserted 'red' row
      // (the higher id) must be the one selected.
      expect(firstRedIds).toContain('RD-0001')
    } finally {
      await db.delete(patientTrialScreenings).where(eq(patientTrialScreenings.id, secondScreening.id))
    }
  })
})

describe('listBroadcasts', () => {
  it('returns the seeded broadcast history, most recent first', async () => {
    const rows = await listBroadcasts()
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(new Date(rows[0].sentAt).getTime()).toBeGreaterThanOrEqual(new Date(rows[rows.length - 1].sentAt).getTime())
  })
})
