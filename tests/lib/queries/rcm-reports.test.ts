import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, patients } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), streamPrivateBlob: vi.fn() }))

import { createClaimDraft } from '@/lib/queries/claims'
import { waiveClaimDocument } from '@/lib/queries/claim-documents'
import { defaultSubmissionDeps, submitClaimVersion } from '@/lib/queries/claim-submissions'
import { applyClaimUpdate, recordSettlement } from '@/lib/queries/claim-updates'
import { agingByPayer, claimRegisterRows, CLAIM_REGISTER_HEADER, denialAnalysis, payerPerformance, rangeProblem } from '@/lib/queries/rcm-reports'
import { makeClaimWorld, destroyClaimWorld, finalisedInvoice, finaliseCoding, type ClaimWorld } from './claim-world'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Report Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const SUBMIT = new Date('2099-06-02T06:00:00Z')
const deps = { ...defaultSubmissionDeps, putBlob: async (path: string) => ({ url: `mem://${path}` }) }
const RANGE = { from: '2099-06-01', to: '2099-06-30' }

describe.skipIf(!process.env.DATABASE_URL)('RCM reports (DB)', () => {
  let w: ClaimWorld
  beforeAll(async () => {
    w = await makeClaimWorld(RUN, 'R')
    await finaliseCoding(w)
    await getDb().update(patients).set({ uhid: `UHT${RUN}` }).where(eq(patients.id, w.patientId))
    const inv = await finalisedInvoice(w, { quantity: 2 })
    const r = await createClaimDraft({ policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, invoices: [{ invoiceId: inv }] }, RCM, SUBMIT)
    if (!r.ok) throw new Error(r.error)
    for (const kind of ['id_proof', 'policy_card', 'prescription'] as const) await waiveClaimDocument(r.value.claimId, kind, 'test waiver', RCM)
    const s = await submitClaimVersion(r.value.claimId, { action: 'submit', channel: 'portal' }, RCM, deps, SUBMIT)
    if (!s.ok) throw new Error(s.error)
    await applyClaimUpdate(r.value.claimId, { action: 'record_decision', approvedPaise: 80_000_00, decidedOn: '2099-06-05', disallowances: [
      { reasonCode: 'NME', amountPaise: 15_000_00, patientRecoverable: true }, { reasonCode: 'TARIFF', amountPaise: 5_000_00, patientRecoverable: false },
    ], insurerClaimReference: 'INS-9' }, RCM, SUBMIT)
    await recordSettlement(r.value.claimId, { utr: `UTR${RUN}R1`, paymentDate: '2099-06-12', receivedPaise: 36_000_00, tdsPaise: 4_000_00, bankChargesPaise: 0 }, RCM, new Date('2099-06-12T06:00:00Z'))
  })
  afterAll(async () => {
    await destroyClaimWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('ageing by payer sums insurer outstanding into buckets', async () => {
    const row = (await agingByPayer(new Date('2099-07-20T06:00:00Z'))).find((r) => r.payerId === w.tpaId)
    expect(row).toMatchObject({ totalPaise: 40_000_00, buckets: expect.objectContaining({ '31-60': 40_000_00, '0-30': 0 }) })
  })
  it('denial analysis groups current deductions by reason with the recoverable split', async () => {
    const rows = await denialAnalysis(RANGE)
    expect(rows.find((r) => r.reasonCode === 'NME')).toMatchObject({ claims: 1, amountPaise: 15_000_00, patientRecoverablePaise: 15_000_00, category: 'disallowance' })
    expect(rows.find((r) => r.reasonCode === 'TARIFF')).toMatchObject({ amountPaise: 5_000_00, patientRecoverablePaise: 0 })
  })
  it('payer performance computes approval rate and days to settle', async () => {
    const row = (await payerPerformance(RANGE)).find((r) => r.payerId === w.tpaId)
    expect(row).toMatchObject({ claims: 1, claimedPaise: 1_00_000_00, approvedPaise: 80_000_00, settledPaise: 40_000_00, tdsPaise: 4_000_00, disallowedPaise: 20_000_00, approvalRateBp: 8000, avgDaysToSettle: 10 })
  })
  it('the claim register has no policy, member, UTR or diagnosis columns', async () => {
    const rows = await claimRegisterRows(RANGE)
    expect(rows[0]).toEqual(CLAIM_REGISTER_HEADER)
    const mine = rows.find((r) => r[3] === `UHT${RUN}`)!
    expect(mine.slice(6)).toEqual(['2099-06-02', '100000.00', '80000.00', '40000.00', '4000.00', '0.00', 'INS-9'])
    const text = JSON.stringify(rows)
    expect(text).not.toMatch(/POL-T1|MEM-T1|UTR|U1Z/)
  })
  it('validates ranges', () => {
    expect(rangeProblem('2099-06-30', '2099-06-01')).toBe('Choose a valid date range'); expect(rangeProblem('2099-13-01', '2099-12-01')).toBe('Choose a valid date range')
    expect(rangeProblem('2098-01-01', '2099-06-01')).toBe('Choose at most one year'); expect(rangeProblem('2099-01-01', '2099-12-31')).toBeNull()
  })
})
