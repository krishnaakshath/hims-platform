// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { abdmProfileShares, claimEvents, claims, nhcxExchanges, nhcxInboundCalls } from '@/db/schema'
import { pollExchangeStatus, runNhcxSweep } from '@/lib/queries/nhcx-exchanges'
import { makeRcmBase, purgeRcmFixtures, deleteRcmBasePatient, type RcmBase } from '../../db/rcm-fixtures'
import { purgeSp8Fixtures, purgeSp8InboundCalls, purgeSp8Shares } from '../../db/sp8-fixtures'

const RUN = `${Date.now()}`.slice(-7)
const NOW = new Date('2099-08-01T06:00:00Z')

describe.skipIf(!process.env.DATABASE_URL)('NHCX sweep (DB)', () => {
  let b: RcmBase
  let claimId = 0
  const inboundIds: string[] = []
  beforeAll(async () => {
    b = await makeRcmBase(RUN, 'SW')
    const [c] = await getDb().insert(claims).values({
      claimNumber: `CLM-2099-SW${RUN}`, patientId: b.patientId, policyId: b.policyId, insurerPayerId: b.insurerId, tpaPayerId: b.tpaId, billingPayerId: b.tpaId,
      claimType: 'opd', encounterId: b.encounterId, createdByName: 'Test', status: 'submitted', claimedPaise: 100,
    }).returning()
    claimId = c.id
  })
  afterAll(async () => {
    await purgeSp8InboundCalls(inboundIds)
    await purgeSp8Shares(`TEST-SP8-${RUN}`)
    await purgeSp8Fixtures([b.patientId])
    await purgeRcmFixtures([b.patientId], [b.insurerId, b.tpaId])
    await deleteRcmBasePatient(b.patientId)
  })
  const outbound = async (over: Partial<typeof nhcxExchanges.$inferInsert>) => (await getDb().insert(nhcxExchanges).values({
    entityType: 'claim', direction: 'outbound', action: 'claim/submit', correlationId: randomUUID(), apiCallId: randomUUID(), senderCode: 'P1@sbx', recipientCode: 'TPA1@sbx',
    state: 'pending_send', patientId: b.patientId, claimId, bodySha256: 'a'.repeat(64), ...over,
  }).returning())[0]

  it('the sweep dispatches due rows, leaves leased rows, and marks 7-day silence as no_response with a note', async () => {
    const due = await outbound({ nextAttemptAt: new Date(NOW.getTime() - 1000) })
    const leased = await outbound({ nextAttemptAt: new Date(NOW.getTime() + 60_000) })
    const silent = await outbound({ state: 'sent', createdAt: new Date(NOW.getTime() - 8 * 86_400_000) })
    const recent = await outbound({ state: 'sent', createdAt: new Date(NOW.getTime() - 86_400_000) })
    const dispatched: number[] = []
    const r = await runNhcxSweep(NOW, { dispatch: async (id) => { dispatched.push(id); return 'sent' }, pollingEnabled: false })
    expect(dispatched).toContain(due.id); expect(dispatched).not.toContain(leased.id)
    expect(r.dispatched).toBeGreaterThanOrEqual(1); expect(r.noResponse).toBeGreaterThanOrEqual(1)
    const state = async (id: number) => (await getDb().select({ s: nhcxExchanges.state }).from(nhcxExchanges).where(eq(nhcxExchanges.id, id)))[0].s
    expect(await state(silent.id)).toBe('no_response'); expect(await state(recent.id)).toBe('sent')
    const notes = await getDb().select().from(claimEvents).where(and(eq(claimEvents.claimId, claimId), eq(claimEvents.action, 'note')))
    expect(notes.map((n) => n.note)).toContain('No NHCX response after 7 days; check the insurer portal')
  })

  it('status polling is off by default', async () => {
    const poll = vi.fn()
    const r = await runNhcxSweep(NOW, { dispatch: async () => 'skipped', poll, pollingEnabled: false })
    expect(r.polled).toBe(0); expect(poll).not.toHaveBeenCalled()
    const x = await outbound({ state: 'sent' })
    const client = vi.fn()
    expect(await pollExchangeStatus(x.id, { client, enabled: false })).toBe('disabled')
    expect(client).not.toHaveBeenCalled()
  })

  it('inbound call rows older than 30 days are purged; newer ones stay', async () => {
    const old = randomUUID(); const fresh = randomUUID(); inboundIds.push(old, fresh)
    await getDb().insert(nhcxInboundCalls).values([
      { apiCallId: old, action: 'claim/on_submit', senderCode: 'TPA1@sbx', correlationId: randomUUID(), outcome: 'accepted', receivedAt: new Date(NOW.getTime() - 31 * 86_400_000) },
      { apiCallId: fresh, action: 'claim/on_submit', senderCode: 'TPA1@sbx', correlationId: randomUUID(), outcome: 'accepted', receivedAt: new Date(NOW.getTime() - 86_400_000) },
    ])
    const r = await runNhcxSweep(NOW, { dispatch: async () => 'skipped', pollingEnabled: false })
    expect(r.inboundPurged).toBeGreaterThanOrEqual(1)
    const left = await getDb().select().from(nhcxInboundCalls).where(sql`${nhcxInboundCalls.apiCallId} in (${old}, ${fresh})`)
    expect(left.map((l) => l.apiCallId)).toEqual([fresh])
  })

  it('pending shares older than 24 h are expired and scrubbed', async () => {
    const [s] = await getDb().insert(abdmProfileShares).values({
      requestId: `TEST-SP8-${RUN}-SW`, hipId: 'HFR', counterId: `S${RUN}`, intent: 'REGISTRATION', name: 'Someone', abhaNumber: '91000000000123', tokenDate: '2099-07-30', tokenNumber: 1,
      receivedAt: new Date(NOW.getTime() - 2 * 86_400_000),
    }).returning()
    const r = await runNhcxSweep(NOW, { dispatch: async () => 'skipped', pollingEnabled: false })
    expect(r.sharesExpired).toBeGreaterThanOrEqual(1)
    const [after] = await getDb().select().from(abdmProfileShares).where(eq(abdmProfileShares.id, s.id))
    expect(after).toMatchObject({ status: 'expired', name: null, abhaNumber: null })
  })
})
