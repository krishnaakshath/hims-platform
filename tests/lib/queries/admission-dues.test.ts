import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissionDuesClearances, admissions, auditLog, chargeLines, invoices, patientPayments, preauths, providers, refunds, serviceCatalog,
} from '@/db/schema'
import type { Session } from '@/lib/auth'
import { loadAdmissionDues, recordDuesClearance } from '@/lib/queries/admission-dues'
import { purgeBillingFixtures } from '../../db/billing-fixtures'
import { deleteRcmBasePatient, makeRcmBase, purgeRcmFixtures, type RcmBase } from '../../db/rcm-fixtures'

// WS3 T5: dues for one admission against the real DB (spec 3.2 item 13).
describe.skipIf(!process.env.DATABASE_URL)('admission dues (DB)', () => {
  const RUN = `${Date.now() % 1e8}${Math.floor(Math.random() * 1e3)}`
  const billing: Session = { role: 'billing', name: `TEST_WS3T5 billing ${RUN}`, userId: null }
  const NOW = new Date('2099-06-03T06:00:00Z') // 11:30 IST on 3 June 2099
  let base: RcmBase
  let providerId = 0
  let service: { id: number; code: string; name: string; hsnSac: string }
  let admissionId = 0
  let otherAdmissionId = 0
  const extraAdmissions: number[] = []
  let doc = 0
  const num = () => `TWS3T5-${RUN}-${++doc}`

  async function line(over: Partial<typeof chargeLines.$inferInsert> = {}) {
    const [l] = await getDb().insert(chargeLines).values({
      patientId: base.patientId, admissionId, source: 'manual', serviceId: service.id, itemCode: service.code, itemName: service.name,
      serviceDate: '2099-06-01', quantity: 1, unitPricePaise: 1_500_00, priceSource: 'base', taxablePaise: 1_500_00, gstRateBp: 0,
      hsnSac: service.hsnSac, createdByName: billing.name, ...over,
    }).returning()
    return l.id
  }
  async function pay(kind: 'advance' | 'receipt', amountPaise: number, over: Partial<typeof patientPayments.$inferInsert> = {}) {
    await getDb().insert(patientPayments).values({
      receiptNumber: num(), kind, patientId: base.patientId, admissionId, mode: 'cash', amountPaise, financialYear: '2099-00',
      receiptDate: '2099-06-01', receivedByName: billing.name, ...over,
    })
  }
  async function draftInvoice(forAdmission: number) {
    const [i] = await getDb().insert(invoices).values({ patientId: base.patientId, admissionId: forAdmission, createdByName: billing.name }).returning()
    return i.id
  }
  async function reset() {
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`select set_config('hims.allow_document_purge', 'on', true)`)
      await tx.delete(preauths).where(eq(preauths.patientId, base.patientId))
    })
    await purgeBillingFixtures([base.patientId])
    await getDb().delete(admissionDuesClearances).where(eq(admissionDuesClearances.admissionId, admissionId))
  }

  beforeAll(async () => {
    const db = getDb()
    base = await makeRcmBase(RUN, 'D')
    const [p] = await db.select({ id: providers.id }).from(providers).orderBy(providers.id).limit(1)
    providerId = p.id
    const [s] = await db.select({ id: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name, hsnSac: serviceCatalog.hsnSac }).from(serviceCatalog).orderBy(serviceCatalog.id).limit(1)
    service = s
    const [a] = await db.insert(admissions).values({ patientId: base.patientId, attendingProviderId: providerId, admittedAt: new Date('2099-06-01T04:00:00Z') }).returning()
    admissionId = a.id
    const [o] = await db.insert(admissions).values({
      patientId: base.patientId, attendingProviderId: providerId, admittedAt: new Date('2099-01-01T04:00:00Z'), status: 'discharged', dischargedAt: new Date('2099-01-03T04:00:00Z'),
    }).returning()
    otherAdmissionId = o.id
  })

  afterAll(async () => {
    const db = getDb()
    await reset()
    await purgeRcmFixtures([base.patientId], [base.insurerId, base.tpaId])
    await db.delete(admissions).where(inArray(admissions.id, [admissionId, otherAdmissionId, ...extraAdmissions]))
    await db.delete(auditLog).where(eq(auditLog.patientId, base.patientId))
    await deleteRcmBasePatient(base.patientId)
  })

  it('ignores void lines and adds intra-state GST to live ones', async () => {
    await reset()
    await line()
    await line({ taxablePaise: 350_00, unitPricePaise: 350_00, gstRateBp: 1200 })
    await line({ status: 'void', voidReason: 'Entered twice', voidedAt: NOW, voidedByName: billing.name, taxablePaise: 9_999_00, unitPricePaise: 9_999_00 })
    const r = await loadAdmissionDues(admissionId)
    expect(r!.dues).toMatchObject({ chargesPaise: 1_89_200, paidPaise: 0, outstandingPaise: 1_89_200 })
    expect(r!.latestClearance).toBeNull()
  })

  it('nets refunds against the admission advance', async () => {
    await reset()
    await line()
    await pay('advance', 1_000_00)
    await getDb().insert(refunds).values({
      refundNumber: num(), patientId: base.patientId, admissionId, mode: 'cash', amountPaise: 300_00, reason: 'Part refund',
      financialYear: '2099-00', refundDate: '2099-06-02', issuedByName: billing.name,
    })
    const r = await loadAdmissionDues(admissionId)
    expect(r!.dues).toMatchObject({ chargesPaise: 1_500_00, paidPaise: 700_00, outstandingPaise: 800_00 })
  })

  it("counts receipts against this admission's invoices only", async () => {
    await reset()
    await line()
    const mine = await draftInvoice(admissionId)
    const theirs = await draftInvoice(otherAdmissionId)
    await pay('receipt', 200_00, { invoiceId: mine, admissionId: null })
    await pay('receipt', 5_000_00, { invoiceId: theirs, admissionId: null })
    const r = await loadAdmissionDues(admissionId)
    expect(r!.dues).toMatchObject({ paidPaise: 200_00, outstandingPaise: 1_300_00 })
  })

  it("caps the insurer share at the latest approved pre-auth linked to the admission", async () => {
    await reset()
    await line({ payerId: base.insurerId })
    const pre = (status: 'approved' | 'rejected', approvedPaise: number | null, n: string) => ({
      preauthNumber: `PA-2099-T5${RUN}${n}`, patientId: base.patientId, policyId: base.policyId, insurerPayerId: base.insurerId, admissionId,
      claimType: 'ipd' as const, status, plannedAdmissionDate: '2099-06-01', expectedLengthOfStayDays: 3, treatingProviderId: providerId,
      estimateLines: [], estimatedPaise: 0, requestedPaise: 0, createdByName: billing.name,
      approvedPaise, approvalReference: approvedPaise === null ? null : `APR-${RUN}${n}`, validUntil: approvedPaise === null ? null : '2099-12-31',
    })
    await getDb().insert(preauths).values(pre('approved', 1_000_00, 'A'))
    await getDb().insert(preauths).values(pre('rejected', null, 'B')) // later, but not approved
    const r = await loadAdmissionDues(admissionId)
    expect(r!.dues).toMatchObject({ payerChargesPaise: 1_500_00, insurerSharePaise: 1_000_00, outstandingPaise: 500_00 })
  })

  it('reports un-posted room-rent days without adding them', async () => {
    await reset()
    await line({ source: 'room_rent', serviceDate: '2099-06-01' })
    const r = await loadAdmissionDues(admissionId, undefined, NOW)
    // Admitted 1 June; discharging on 3 June bills 1 and 2 June (census days); 1 June is posted.
    expect(r!.roomRentPostedThrough).toBe('2099-06-01')
    expect(r!.unpostedRoomRentDays).toBe(1)
    expect(r!.dues.chargesPaise).toBe(1_500_00)
  })

  it('answers null for an unknown admission', async () => {
    expect(await loadAdmissionDues(2147483000)).toBeNull()
  })

  it('recordDuesClearance: reason required while dues are outstanding; a reasoned clearance is stored and audited by ids', async () => {
    await reset()
    await line()
    expect(await recordDuesClearance(admissionId, null, billing, NOW)).toEqual({ ok: false, error: 'reason_required' })
    const ok = await recordDuesClearance(admissionId, 'Corporate tie-up, billed monthly', billing, NOW)
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.clearance).toMatchObject({ admissionId, chargesPaise: 1_500_00, paidPaise: 0, insurerSharePaise: 0, outstandingPaise: 1_500_00, overrideReason: 'Corporate tie-up, billed monthly', clearedByName: billing.name })
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.patientId, base.patientId), eq(auditLog.action, 'cleared discharge dues')))
    expect(audits.map((a) => a.details)).toEqual([`admission=${admissionId} outstanding=150000`])
    const r = await loadAdmissionDues(admissionId)
    expect(r!.latestClearance?.id).toBe(ok.clearance.id)
  })

  it('recordDuesClearance: zero dues need no reason; unknown and discharged admissions are refused', async () => {
    await reset()
    const zero = await recordDuesClearance(admissionId, null, billing, NOW)
    expect(zero).toMatchObject({ ok: true, clearance: { outstandingPaise: 0, overrideReason: null } })
    expect(await recordDuesClearance(2147483000, null, billing, NOW)).toEqual({ ok: false, error: 'not_found' })
    expect(await recordDuesClearance(otherAdmissionId, 'Corporate tie-up, billed monthly', billing, NOW)).toEqual({ ok: false, error: 'not_admitted' })
  })

  it('the database refuses an outstanding clearance without a reason', async () => {
    await expect(getDb().insert(admissionDuesClearances).values({
      admissionId, chargesPaise: 100, paidPaise: 0, insurerSharePaise: 0, outstandingPaise: 100, clearedByName: billing.name,
    })).rejects.toMatchObject({ cause: { code: '23514' } })
  })

  it('deleting the admission removes its clearances (ON DELETE CASCADE)', async () => {
    const db = getDb()
    const [a] = await db.insert(admissions).values({ patientId: base.patientId, attendingProviderId: providerId, admittedAt: NOW, status: 'discharged', dischargedAt: NOW }).returning()
    extraAdmissions.push(a.id)
    await db.insert(admissionDuesClearances).values({ admissionId: a.id, chargesPaise: 0, paidPaise: 0, insurerSharePaise: 0, outstandingPaise: 0, clearedByName: billing.name })
    await db.delete(admissions).where(eq(admissions.id, a.id))
    expect(await db.select().from(admissionDuesClearances).where(eq(admissionDuesClearances.admissionId, a.id))).toEqual([])
  })
})
