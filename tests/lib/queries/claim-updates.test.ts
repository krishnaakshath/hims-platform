import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { and, eq, inArray, like } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, claimDisallowances, claims, users } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), streamPrivateBlob: vi.fn() }))

import { createClaimDraft } from '@/lib/queries/claims'
import { waiveClaimDocument } from '@/lib/queries/claim-documents'
import { defaultSubmissionDeps, submitClaimVersion } from '@/lib/queries/claim-submissions'
import { applyClaimUpdate, decideWriteOff, reconcileSettlement, recordSettlement, requestWriteOff } from '@/lib/queries/claim-updates'
import { getPatientLedger } from '@/lib/queries/patient-ledger'
import { makeClaimWorld, destroyClaimWorld, finalisedInvoice, finaliseCoding, type ClaimWorld } from './claim-world'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Update Probe`
const NOW = new Date('2099-06-02T06:00:00Z')
const deps = { ...defaultSubmissionDeps, putBlob: async (path: string) => ({ url: `mem://${path}` }) }

describe.skipIf(!process.env.DATABASE_URL)('insurer updates, settlements and write-offs (DB)', () => {
  let w: ClaimWorld
  let RCM: Session
  let ADMIN_B: Session
  const userIds: number[] = []
  const ENV_ADMIN: Session = { role: 'admin', name: PROBE, userId: null }
  const submittedClaim = async () => {
    const inv = await finalisedInvoice(w, { quantity: 2 })
    const r = await createClaimDraft({ policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, invoices: [{ invoiceId: inv }] }, RCM, NOW)
    if (!r.ok) throw new Error(r.error)
    for (const kind of ['id_proof', 'policy_card', 'prescription'] as const) await waiveClaimDocument(r.value.claimId, kind, 'test waiver', RCM)
    const s = await submitClaimVersion(r.value.claimId, { action: 'submit', channel: 'portal' }, RCM, deps, NOW)
    if (!s.ok) throw new Error(`${s.error} ${JSON.stringify(s.items ?? [])}`)
    return r.value.claimId
  }
  const DECISION = {
    action: 'record_decision' as const, approvedPaise: 80_000_00, decidedOn: '2099-06-10',
    disallowances: [{ reasonCode: 'NME', amountPaise: 15_000_00, patientRecoverable: true }, { reasonCode: 'TARIFF', amountPaise: 5_000_00, patientRecoverable: false }],
  }
  const SETTLE = { utr: `UTR${RUN}A1`, paymentDate: '2099-06-20', receivedPaise: 72_000_00, tdsPaise: 8_000_00, bankChargesPaise: 0 }

  beforeAll(async () => {
    w = await makeClaimWorld(RUN, 'U')
    await finaliseCoding(w)
    const [a] = await getDb().insert(users).values({ name: PROBE, email: `test-sp7-${RUN}-a@example.invalid`, role: 'rcm' }).returning()
    const [b] = await getDb().insert(users).values({ name: PROBE, email: `test-sp7-${RUN}-b@example.invalid`, role: 'admin' }).returning()
    userIds.push(a.id, b.id)
    RCM = { role: 'rcm', name: PROBE, userId: a.id }
    ADMIN_B = { role: 'admin', name: PROBE, userId: b.id }
  })
  afterAll(async () => {
    await destroyClaimWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
    await getDb().delete(users).where(inArray(users.id, userIds))
  })

  it('a partial approval with reconciling deductions sets the money columns', async () => {
    const id = await submittedClaim()
    expect(await applyClaimUpdate(id, DECISION, RCM, NOW)).toEqual({ ok: true, value: { status: 'partially_approved', warnings: [] } })
    const [c] = await getDb().select().from(claims).where(eq(claims.id, id))
    expect(c).toMatchObject({ approvedPaise: 80_000_00, disallowedPaise: 20_000_00, nonRecoverableDisallowedPaise: 5_000_00, status: 'partially_approved' })
    expect(await getDb().select().from(claimDisallowances).where(eq(claimDisallowances.claimId, id))).toHaveLength(2)
    expect(c.currentDecisionEventId).not.toBeNull()
  })

  it('approval amounts that do not add up are refused with the gap', async () => {
    const id = await submittedClaim()
    expect(await applyClaimUpdate(id, { ...DECISION, disallowances: [DECISION.disallowances[0]] }, RCM, NOW))
      .toEqual({ ok: false, error: 'amounts_invalid', message: 'Disallowed amounts must add up to the claimed amount less the approved amount (₹20,000.00)' })
    expect(await applyClaimUpdate(id, { ...DECISION, disallowances: [{ ...DECISION.disallowances[0], reasonCode: 'EXCL', amountPaise: 20_000_00 }] }, RCM, NOW)).toEqual({ ok: false, error: 'code_not_found' })
  })

  it('a double-submitted settlement with the same UTR posts once; above the approved amount still due is refused', async () => {
    const id = await submittedClaim()
    await applyClaimUpdate(id, DECISION, RCM, NOW)
    const [a, b] = await Promise.all([recordSettlement(id, SETTLE, RCM, NOW), recordSettlement(id, SETTLE, RCM, NOW)])
    expect([a.ok, b.ok].sort()).toEqual([false, true]); expect(a.ok ? b : a).toMatchObject({ error: 'duplicate_utr' })
    expect(await recordSettlement(id, { ...SETTLE, utr: `UTR${RUN}A2`, receivedPaise: 1 }, RCM, NOW))
      .toEqual({ ok: false, error: 'amounts_invalid', message: 'Settlement exceeds the approved amount still due (₹0.00)' })
    const [c] = await getDb().select().from(claims).where(eq(claims.id, id))
    expect(c).toMatchObject({ settledPaise: 80_000_00, status: 'settled' })
    const ok = a.ok ? a : b
    if (ok.ok) expect(ok.value.warnings).toEqual([])
  })

  it('a write-off needs a second person and stays within the ceiling', async () => {
    const id = await submittedClaim()
    await applyClaimUpdate(id, DECISION, RCM, NOW)
    await recordSettlement(id, { ...SETTLE, utr: `UTR${RUN}B1` }, RCM, NOW)
    expect(await requestWriteOff(id, { amountPaise: 5_000_01, reasonCode: 'ABSORB', note: 'tariff gap' }, RCM, NOW))
      .toEqual({ ok: false, error: 'write_off_exceeds', message: 'The write-off is more than the ₹5,000.00 still open on this claim' })
    const req = await requestWriteOff(id, { amountPaise: 5_000_00, reasonCode: 'ABSORB', note: 'tariff gap' }, RCM, NOW)
    if (!req.ok) throw new Error(req.error)
    expect(await decideWriteOff(req.value.writeOffId, { decision: 'approve' }, RCM, NOW)).toEqual({ ok: false, error: 'same_approver' })
    expect(await decideWriteOff(req.value.writeOffId, { decision: 'approve' }, ENV_ADMIN, NOW)).toEqual({ ok: false, error: 'no_user_account' })
    expect(await decideWriteOff(req.value.writeOffId, { decision: 'approve' }, ADMIN_B, NOW)).toEqual({ ok: true, value: null })
    expect(await decideWriteOff(req.value.writeOffId, { decision: 'reject' }, ADMIN_B, NOW)).toEqual({ ok: false, error: 'already_decided' })
    const [c] = await getDb().select().from(claims).where(eq(claims.id, id))
    expect(c.writtenOffPaise).toBe(5_000_00)
  })

  it('close is blocked until reconciled and nothing is pending, then reopens to settled', async () => {
    const id = await submittedClaim()
    await applyClaimUpdate(id, DECISION, RCM, NOW)
    const st = await recordSettlement(id, { ...SETTLE, utr: `UTR${RUN}C1` }, RCM, NOW)
    if (!st.ok) throw new Error(st.error)
    expect(await applyClaimUpdate(id, { action: 'close' }, RCM, NOW)).toEqual({ ok: false, error: 'close_blocked', message: 'Reconcile every settlement with the bank first' })
    expect(await reconcileSettlement(st.value.settlementId, { bankCreditDate: '2099-06-21' }, RCM)).toEqual({ ok: true, value: null })
    expect(await reconcileSettlement(st.value.settlementId, { bankCreditDate: '2099-06-21' }, RCM)).toEqual({ ok: false, error: 'already_reconciled' })
    expect(await applyClaimUpdate(id, { action: 'close' }, RCM, NOW)).toEqual({ ok: false, error: 'close_blocked', message: '₹5,000.00 is still due from the insurer or must be written off' })
    const wo = await requestWriteOff(id, { amountPaise: 5_000_00, reasonCode: 'ABSORB', note: 'tariff gap' }, RCM, NOW)
    if (!wo.ok) throw new Error(wo.error)
    await decideWriteOff(wo.value.writeOffId, { decision: 'approve' }, ADMIN_B, NOW)
    expect(await applyClaimUpdate(id, { action: 'close' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'closed', warnings: [] } })
    expect(await applyClaimUpdate(id, { action: 'reopen', reason: 'insurer reversal' }, RCM, NOW)).toEqual({ ok: true, value: { status: 'settled', warnings: [] } })
  })

  it('a rejection is a full-amount disallowance with its reason', async () => {
    const id = await submittedClaim()
    expect(await applyClaimUpdate(id, { action: 'record_rejection', decidedOn: '2099-06-10', reasonCode: 'PED', patientRecoverable: true, note: 'waiting period' }, RCM, NOW))
      .toEqual({ ok: true, value: { status: 'rejected', warnings: [] } })
    const [c] = await getDb().select().from(claims).where(eq(claims.id, id))
    expect(c).toMatchObject({ approvedPaise: 0, disallowedPaise: 1_00_000_00, nonRecoverableDisallowedPaise: 0 })
    const [d] = await getDb().select().from(claimDisallowances).where(eq(claimDisallowances.claimId, id))
    expect(d).toMatchObject({ reasonCode: 'PED', amountPaise: 1_00_000_00, patientRecoverable: true })
  })

  it('the ledger shows each settlement exactly once; patient payable excludes what the insurer still owes', async () => {
    const before = (await getPatientLedger(w.patientId))!
    const id = await submittedClaim()
    await applyClaimUpdate(id, DECISION, RCM, NOW)
    const mid = (await getPatientLedger(w.patientId))!
    expect(mid.coveredPendingPaise - before.coveredPendingPaise).toBe(85_000_00)
    expect(mid.ledger.summary.outstandingPaise - before.ledger.summary.outstandingPaise).toBe(1_00_000_00)
    await recordSettlement(id, { ...SETTLE, utr: `UTR${RUN}D1`, receivedPaise: 80_000_00, tdsPaise: 0 }, RCM, NOW)
    const wo = await requestWriteOff(id, { amountPaise: 5_000_00, reasonCode: 'ABSORB', note: 'gap' }, RCM, NOW)
    if (wo.ok) await decideWriteOff(wo.value.writeOffId, { decision: 'approve' }, ADMIN_B, NOW)
    const one = (await getPatientLedger(w.patientId))!
    const two = (await getPatientLedger(w.patientId))!
    const [{ n: claimNumber }] = await getDb().select({ n: claims.claimNumber }).from(claims).where(eq(claims.id, id))
    expect(one.ledger.rows.filter((r) => r.kind === 'insurer_settlement' && r.number.startsWith(`${claimNumber}/`))).toHaveLength(1)
    expect(one.ledger.summary.balancePaise).toBe(two.ledger.summary.balancePaise)
    expect(one.coveredPendingPaise).toBe(before.coveredPendingPaise)
    expect(one.ledger.summary.outstandingPaise - before.ledger.summary.outstandingPaise).toBe(15_000_00)
  })

  // Whole-branch review finding 4.
  it('an appeal decision cannot approve less than is already settled', async () => {
    const id = await submittedClaim()
    await applyClaimUpdate(id, DECISION, RCM, NOW)
    await recordSettlement(id, { ...SETTLE, utr: `UTR${RUN}E1` }, RCM, NOW)
    expect((await applyClaimUpdate(id, { action: 'record_rejection', decidedOn: '2099-06-10', reasonCode: 'PED', patientRecoverable: true }, RCM, NOW)).ok).toBe(false)
    await getDb().update(claims).set({ status: 'appealed' }).where(eq(claims.id, id))
    expect(await applyClaimUpdate(id, { action: 'record_decision', approvedPaise: 70_000_00, decidedOn: '2099-06-20', disallowances: [{ reasonCode: 'NME', amountPaise: 30_000_00, patientRecoverable: true }] }, RCM, NOW))
      .toEqual({ ok: false, error: 'amounts_invalid', message: 'The approved amount cannot be less than the ₹80,000.00 already settled' })
  })

  it('audit details carry no UTR or note', async () => {
    const rows = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, PROBE), like(auditLog.action, 'rcm: %')))
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['rcm: claim record_partial_approval', 'rcm: recorded settlement', 'rcm: requested write-off', 'rcm: approved write-off', 'rcm: claim close', 'rcm: claim record_rejection']))
    for (const r of rows) expect(`${r.details}`).not.toMatch(/UTR|tariff gap|waiting period|reversal/i)
  })
})
