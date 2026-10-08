import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { auditLog, claims, patients, payerProfiles } from '@/db/schema'
import type { Session } from '@/lib/auth'

vi.mock('@/lib/blob-store', () => ({ putPrivateBlob: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })), streamPrivateBlob: vi.fn() }))

import { createClaimDraft } from '@/lib/queries/claims'
import { waiveClaimDocument } from '@/lib/queries/claim-documents'
import { defaultSubmissionDeps, submitClaimVersion } from '@/lib/queries/claim-submissions'
import { getRcmDashboard, listClaimCandidates, listClaims } from '@/lib/queries/rcm-worklist'
import { getClaimWorkspace } from '@/lib/queries/claim-workspace'
import { makeClaimWorld, destroyClaimWorld, finalisedInvoice, finaliseCoding, type ClaimWorld } from './claim-world'

const RUN = `${Date.now()}`.slice(-7)
const PROBE = `TEST-SP7-${RUN} Worklist Probe`
const RCM: Session = { role: 'rcm', name: PROBE, userId: null }
const ADMIN: Session = { role: 'admin', name: PROBE, userId: null }
const NOW = new Date('2099-06-02T06:00:00Z')
const deps = { ...defaultSubmissionDeps, putBlob: async (path: string) => ({ url: `mem://${path}` }) }

describe.skipIf(!process.env.DATABASE_URL)('RCM worklists and the claim workspace (DB)', () => {
  let w: ClaimWorld
  let draftId = 0
  let submittedId = 0
  beforeAll(async () => {
    w = await makeClaimWorld(RUN, 'W')
    await finaliseCoding(w)
  })
  afterAll(async () => {
    await destroyClaimWorld(w)
    await getDb().delete(auditLog).where(eq(auditLog.userName, PROBE))
  })

  it('places claims on their worklists and candidates appear until claimed', async () => {
    const inv = await finalisedInvoice(w)
    const mine = (await listClaimCandidates(NOW)).filter((c) => c.patient.id === w.patientId)
    expect(mine).toEqual([expect.objectContaining({ encounterId: w.encounterId, admissionId: null, policyId: w.policyId, invoiceCount: 1, availablePaise: 50_000_00 })])
    expect(JSON.stringify(mine)).not.toMatch(/phone|email|address/i)
    const r = await createClaimDraft({ policyId: w.policyId, claimType: 'opd', encounterId: w.encounterId, invoices: [{ invoiceId: inv }] }, RCM, NOW)
    if (!r.ok) throw new Error(r.error)
    draftId = r.value.claimId
    expect((await listClaimCandidates(NOW)).filter((c) => c.patient.id === w.patientId)).toEqual([])
    const toSubmit = await listClaims({ tab: 'to_submit', now: NOW })
    expect(toSubmit.rows.find((row) => row.id === draftId)).toMatchObject({ status: 'draft', worklists: ['to_submit'], ageDays: null })
    for (const kind of ['id_proof', 'policy_card', 'prescription'] as const) await waiveClaimDocument(draftId, kind, 'test waiver', RCM)
    const s = await submitClaimVersion(draftId, { action: 'submit', channel: 'portal' }, RCM, deps, NOW)
    if (!s.ok) throw new Error(s.error)
    submittedId = draftId
    const awaiting = await listClaims({ tab: 'awaiting_insurer', now: NOW })
    expect(awaiting.rows.find((row) => row.id === submittedId)).toMatchObject({ worklists: ['awaiting_insurer'], insurerOutstandingPaise: 50_000_00 })
    const [c] = await getDb().select({ n: claims.claimNumber }).from(claims).where(eq(claims.id, submittedId))
    expect((await listClaims({ q: c.n, now: NOW })).rows.map((row) => row.id)).toEqual([submittedId])
  })

  it('ageing buckets use the first submission date in IST', async () => {
    const later = new Date('2099-07-15T20:00:00Z') // 16 Jul IST
    const row = (await listClaims({ tab: 'awaiting_insurer', now: later })).rows.find((r) => r.id === submittedId)
    expect(row).toMatchObject({ ageDays: 44, agingBucket: '31-60', slaFlags: ['settlement_overdue'] })
    const dash = await getRcmDashboard(later)
    expect(dash.counts.awaiting_insurer).toBeGreaterThanOrEqual(1)
    expect(dash.aging.find((a) => a.label === '31-60')!.paise).toBeGreaterThanOrEqual(50_000_00)
  })

  it('workspace patient header carries only the RCM minimum', async () => {
    await getDb().update(patients).set({ phone: '9845013210', email: 'x@y.example' }).where(eq(patients.id, w.patientId))
    const ws = await getClaimWorkspace(submittedId, RCM, NOW)
    expect(Object.keys(ws!.patient).sort()).toEqual(['ageYears', 'dob', 'gender', 'id', 'name', 'uhid'])
    expect(JSON.stringify(ws)).not.toMatch(/phone|email|address|blob\.test|mem:\/\/|blobUrl/i)
  })

  it('ABHA appears only for a requiring payer and an allowed role', async () => {
    await getDb().update(patients).set({ abhaNumber: `5${RUN}123456`.slice(0, 14).padEnd(14, '1') }).where(eq(patients.id, w.patientId))
    expect((await getClaimWorkspace(submittedId, RCM, NOW))!.patient.abhaNumber).toBeUndefined()
    await getDb().update(payerProfiles).set({ requiresAbha: true }).where(inArray(payerProfiles.payerId, [w.tpaId]))
    expect((await getClaimWorkspace(submittedId, RCM, NOW))!.patient.abhaNumber).toMatch(/^\d{2}-\d{4}-\d{4}-\d{4}$/)
    expect((await getClaimWorkspace(submittedId, { ...ADMIN, role: 'billing' }, NOW))!.patient.abhaNumber).toBeUndefined()
    await getDb().update(payerProfiles).set({ requiresAbha: false }).where(inArray(payerProfiles.payerId, [w.tpaId]))
    await getDb().update(patients).set({ abhaNumber: null }).where(eq(patients.id, w.patientId))
  })

  it('allowedActions follow the status', async () => {
    const ws = await getClaimWorkspace(submittedId, RCM, NOW)
    expect([...ws!.allowedActions].sort()).toEqual(['note', 'record_approval', 'record_partial_approval', 'record_query', 'record_rejection', 'withdraw'])
    expect(ws!.versions[0]).toMatchObject({ version: 1, dispatch: expect.objectContaining({ channel: 'portal', transport: 'manual' }) })
    expect(ws!.readiness.ready).toBe(true)
  })
})
