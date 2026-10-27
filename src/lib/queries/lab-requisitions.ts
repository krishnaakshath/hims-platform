// SP5 doctor's order: one lab_requisitions row grouping the tests a doctor orders together
// (Ruling 7), one lab_orders row per test carrying the price quoted from the SP2 tariff master
// on the IST order date (Ruling 11), and the optional "follow-up after the report" request.
//
// WS2 T10 (spec ruling 6): each order is billed at order time, in the order transaction, through
// the auto-charge seam: context = the patient's active admission, else the originating visit,
// else none (the order is still created, outcome `no_context`). The quote uses the same resolver
// inputs as the line (payer only when the line bills the payer; the context's department, room
// category and ward), and an order whose line was priced differently (a rate changed in between,
// or a payer line fell back to self-pay) takes the line's price, so the quote and the line agree.
//
// Reads and price quotes happen before the transaction; the requisition, its orders, one audit
// row per order and the order lines are written in ONE transaction (lock order: the new
// requisition/lab_orders rows, then the patient billing lock inside the seam; final fix wave: the
// originating visit FOR SHARE before all of them). The local-patient
// notice is the route's job, after commit.
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { chargeLines, encounters, labOrders, labRequisitions, labTests, patients, providers, type LabOrderRow, type LabRequisitionRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { autoBillTo } from '@/lib/billing/visit-charges'
import { istDateOf } from '@/lib/india-time'
import { quoteFromResolution, type LabQuote, type LabQuoteStatus } from '@/lib/labs/catalog'
import type { CreateLabRequisitionRequest, LabOrderPriority } from '@/lib/labs/validation'
import type { LabOrderStatus } from '@/lib/labs/status'
import { admissionFirstChargeContext, captureAutoChargeInTx, type AutoChargeOutcome } from '@/lib/queries/auto-charge'
import type { ChargeContext, ChargeContextRef } from '@/lib/queries/charge-capture'
import { getEncounterById } from '@/lib/queries/encounters'
import { isLocalPatientPin } from '@/lib/queries/lab-setup'
import { loadPricingContext } from '@/lib/queries/tariff'
import { resolvePrice } from '@/lib/tariff/resolve'
import type { WriteExecutor } from '@/lib/queries/executor'

export interface CreateLabRequisitionInput extends CreateLabRequisitionRequest {
  patientId: string
  orderedByProviderId: number
  /**
   * Final fix wave (item 2): what to do when the originating visit is closed (completed or
   * cancelled) under its share lock in the order transaction. 'refuse': the visit was named by the
   * caller, so the order is refused with visit_closed. 'drop': the visit was inferred (the open OPD
   * visit today), so the order goes ahead with no visit (never block the clinical act). Omitted:
   * no check (the demo seed back-dates orders onto past visits).
   */
  closedVisit?: 'refuse' | 'drop'
}

export type QuotedLine = { orderId: number; labTestId: number; quotedPricePaise: number | null; quoteStatus: LabQuoteStatus }

export type CreateLabRequisitionResult =
  // includesLabTest: at least one ordered test is a lab test (not imaging); the home-collection
  // notice is sent only then (Task 8 ruling). charges: one outcome per order, in `lines` order (WS2 T10).
  | { ok: true; requisition: LabRequisitionRow; lines: QuotedLine[]; charges: AutoChargeOutcome[]; patientIsLocal: boolean; includesLabTest: boolean }
  | { ok: false; error: 'patient_not_found' | 'test_not_found' | 'encounter_not_found' | 'encounter_mismatch' | 'test_unmapped' | 'test_inactive' | 'test_unpriced' | 'visit_closed' }

/** WS2 T10: what a lab order of this patient is billed to: the active admission, else the visit, else nothing. */
export async function labOrderChargeContext(
  executor: WriteExecutor, patientId: string, originatingEncounterId: number | null,
): Promise<{ ref: ChargeContextRef; ctx: ChargeContext } | null> {
  return admissionFirstChargeContext(executor, patientId, originatingEncounterId)
}

/** WS2 T10: who a new lab order of this patient (from this visit) would be billed to. */
export async function labOrderBillTo(patientId: string, originatingEncounterId: number | null): Promise<'self' | 'payer'> {
  const c = await labOrderChargeContext(getDb(), patientId, originatingEncounterId)
  return c ? autoBillTo(c.ctx) : 'self'
}

/** WS2 T10: the patient's open (checked in / in consultation) OPD visit with this doctor on this IST date. */
export async function openOpdEncounterFor(patientId: string, providerId: number, dateIso: string): Promise<number | null> {
  const [e] = await getDb().select({ id: encounters.id }).from(encounters).where(and(
    eq(encounters.patientId, patientId), eq(encounters.providerId, providerId), eq(encounters.encounterType, 'opd'),
    eq(encounters.encounterDate, dateIso), inArray(encounters.status, ['checked_in', 'in_consultation']),
  )).orderBy(desc(encounters.id)).limit(1)
  return e?.id ?? null
}

export async function createLabRequisition(input: CreateLabRequisitionInput, session: Session, now = new Date()): Promise<CreateLabRequisitionResult> {
  const db = getDb()
  const onDate = istDateOf(now)

  // 1. Reads (named columns only).
  const [patient] = await db
    .select({ pinCode: patients.pinCode, primaryPayerId: patients.primaryPayerId })
    .from(patients)
    .where(eq(patients.id, input.patientId))
  if (!patient) return { ok: false, error: 'patient_not_found' }

  const testRows = await db.select({ id: labTests.id, serviceId: labTests.serviceId, category: labTests.category, isActive: labTests.isActive, fastingRequired: labTests.fastingRequired }).from(labTests).where(inArray(labTests.id, input.labTestIds))
  const serviceByTest = new Map(testRows.map((t) => [t.id, t.serviceId]))
  if (input.labTestIds.some((id) => !serviceByTest.has(id))) return { ok: false, error: 'test_not_found' }
  // Foundations T10 price-mapping gate: all-or-nothing, before anything is written.
  if (testRows.some((t) => t.serviceId === null)) return { ok: false, error: 'test_unmapped' }
  if (testRows.some((t) => !t.isActive)) return { ok: false, error: 'test_inactive' }
  // end Foundations T10

  if (input.originatingEncounterId !== null) {
    const encounter = await getEncounterById(input.originatingEncounterId)
    if (!encounter) return { ok: false, error: 'encounter_not_found' }
    if (encounter.patientId !== input.patientId) return { ok: false, error: 'encounter_mismatch' }
  }

  const [provider] = await db.select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, input.orderedByProviderId))
  const providerDept = provider?.departmentId ?? null

  // 2. Quotes (SP2 resolver: payer > department > base, on the IST order date), with the inputs
  // the order's line will be priced with (WS2 T10).
  const quoteCharge = await labOrderChargeContext(db, input.patientId, input.originatingEncounterId)
  const ctx = quoteCharge?.ctx ?? null
  const payerId = ctx && autoBillTo(ctx) === 'payer' ? ctx.primaryPayerId : null
  const quotes = new Map<number, LabQuote>()
  for (const labTestId of input.labTestIds) {
    const serviceId = serviceByTest.get(labTestId) ?? null
    if (serviceId === null) {
      quotes.set(labTestId, quoteFromResolution(null))
      continue
    }
    const res = resolvePrice(
      {
        serviceId,
        payerId: payerId ?? undefined,
        departmentId: (ctx ? ctx.departmentId : providerDept) ?? undefined,
        roomCategory: ctx?.roomCategoryCode ?? undefined,
        ward: ctx?.ward ?? undefined,
        onDate,
      },
      await loadPricingContext(serviceId),
    )
    quotes.set(labTestId, quoteFromResolution(res))
  }

  // Foundations T10: a mapped test whose service is inactive or has no current rate is as unpriced as an
  // unmapped one. Same resolver as the quote above; nothing has been written yet.
  if (input.labTestIds.some((id) => quotes.get(id)!.quoteStatus !== 'quoted')) return { ok: false, error: 'test_unpriced' }

  // WS1 T10 (ruling R3): fasting defaults to true when any ordered test needs it.
  const fastingRequired = input.fastingRequired ?? testRows.some((t) => t.fastingRequired)

  // 3. One transaction: requisition, one order per test (input order), one audit and one line per order.
  const written = await db.transaction(async (tx) => {
    // Final fix wave (item 2): the originating visit FOR SHARE first (before the order rows and the
    // billing lock; the visit cancel takes it FOR UPDATE before the visit's orders), so an order and
    // a visit cancel serialise: the cancel then sees and cancels this order, or the order sees the
    // closed visit here.
    let originatingEncounterId = input.originatingEncounterId
    let charge = quoteCharge
    if (originatingEncounterId !== null) {
      const [v] = await tx.select({ status: encounters.status }).from(encounters).where(eq(encounters.id, originatingEncounterId)).for('share')
      if (input.closedVisit !== undefined && (!v || v.status === 'completed' || v.status === 'cancelled')) {
        if (input.closedVisit === 'refuse') return { closed: true as const }
        originatingEncounterId = null
        if (charge !== null && 'encounterId' in charge.ref) charge = null
      }
    }
    const [req] = await tx
      .insert(labRequisitions)
      .values({
        patientId: input.patientId,
        orderedByProviderId: input.orderedByProviderId,
        originatingEncounterId,
        followUpRequested: input.followUp !== null,
        followUpIntervalValue: input.followUp?.interval.value ?? null,
        followUpIntervalUnit: input.followUp?.interval.unit ?? null,
        followUpReason: input.followUp?.reason ?? null,
        createdByName: session.name,
        createdByUserId: session.userId ?? null,
        priority: input.priority, // WS1 T10
        clinicalNotes: input.clinicalNotes, // WS1 T10
        fastingRequired, // WS1 T10
      })
      .returning()
    const out: QuotedLine[] = []
    const outcomes: AutoChargeOutcome[] = []
    for (const labTestId of input.labTestIds) {
      const quote = quotes.get(labTestId)!
      const [order] = await tx
        .insert(labOrders)
        .values({
          patientId: input.patientId,
          labTestId,
          orderedByProviderId: input.orderedByProviderId,
          status: 'ordered',
          orderedAt: now,
          requisitionId: req.id,
          quotedPricePaise: quote.quotedPricePaise,
          quotedTariffRateId: quote.quotedTariffRateId,
          quotedOn: onDate,
          quoteStatus: quote.quoteStatus,
        })
        .returning({ id: labOrders.id })
      await logAudit(session, 'created lab order', input.patientId, `order=${order.id} requisition=${req.id} quote=${quote.quoteStatus}`, tx)
      const line: QuotedLine = { orderId: order.id, labTestId, quotedPricePaise: quote.quotedPricePaise, quoteStatus: quote.quoteStatus }

      // WS2 T10: the order's line, inside this transaction (never throws for a business reason).
      const outcome: AutoChargeOutcome = charge === null
        ? { ok: false, source: 'lab_order', reason: 'no_context' }
        : await captureAutoChargeInTx(tx, {
          context: charge.ref, serviceId: serviceByTest.get(labTestId)!, quantity: 1, serviceDate: onDate, source: 'lab_order', links: { labOrderId: order.id },
        }, session, now)
      if (outcome.ok) {
        const [priced] = await tx.select({ unitPricePaise: chargeLines.unitPricePaise, tariffRateId: chargeLines.tariffRateId })
          .from(chargeLines).where(eq(chargeLines.id, outcome.lineId))
        if (priced && (priced.unitPricePaise !== quote.quotedPricePaise || priced.tariffRateId !== quote.quotedTariffRateId)) {
          await tx.update(labOrders).set({ quotedPricePaise: priced.unitPricePaise, quotedTariffRateId: priced.tariffRateId }).where(eq(labOrders.id, order.id))
          line.quotedPricePaise = priced.unitPricePaise
        }
      }
      out.push(line)
      outcomes.push(outcome)
    }
    return { closed: false as const, requisition: req, lines: out, charges: outcomes }
  })
  if (written.closed) return { ok: false, error: 'visit_closed' }
  const { requisition, lines, charges } = written

  // 4. Local patient (Ruling 3: the registered SP1 PIN against the active service-area list).
  const patientIsLocal = await isLocalPatientPin(patient.pinCode)
  const includesLabTest = testRows.some((t) => t.category === 'lab')
  return { ok: true, requisition, lines, charges, patientIsLocal, includesLabTest }
}

// ── WS2 T10: a visit's orders (the workspace Orders panel) ───────────────────

export interface EncounterLabOrderRow {
  id: number
  requisitionId: number
  testName: string
  testCode: string
  category: 'lab' | 'imaging'
  status: LabOrderStatus
  priority: LabOrderPriority
  fastingRequired: boolean
  orderedAt: Date
  quotedPricePaise: number | null
  /** billed: a live line; void: its line was voided; not_billed: no line (see "Orders not billed"). */
  billing: 'billed' | 'void' | 'not_billed'
}

/** The orders placed from one visit, oldest first, with their line state. */
export async function listEncounterLabOrders(encounterId: number): Promise<EncounterLabOrderRow[]> {
  const rows = await getDb()
    .select({
      id: labOrders.id, requisitionId: labRequisitions.id, testName: labTests.name, testCode: labTests.code, category: labTests.category,
      status: labOrders.status, priority: labRequisitions.priority, fastingRequired: labRequisitions.fastingRequired,
      orderedAt: labOrders.orderedAt, quotedPricePaise: labOrders.quotedPricePaise, lineStatus: chargeLines.status,
    })
    .from(labOrders)
    .innerJoin(labRequisitions, eq(labRequisitions.id, labOrders.requisitionId))
    .innerJoin(labTests, eq(labTests.id, labOrders.labTestId))
    .leftJoin(chargeLines, eq(chargeLines.labOrderId, labOrders.id))
    .where(eq(labRequisitions.originatingEncounterId, encounterId))
    .orderBy(asc(labOrders.orderedAt), asc(labOrders.id))
  return rows.map(({ lineStatus, ...r }) => ({ ...r, billing: lineStatus === null ? 'not_billed' : lineStatus === 'void' ? 'void' : 'billed' }))
}

export async function getRequisitionWithOrders(id: number): Promise<{ requisition: LabRequisitionRow; orders: LabOrderRow[] } | null> {
  const db = getDb()
  const [requisition] = await db.select().from(labRequisitions).where(eq(labRequisitions.id, id))
  if (!requisition) return null
  const orders = await db.select().from(labOrders).where(eq(labOrders.requisitionId, id)).orderBy(asc(labOrders.id))
  return { requisition, orders }
}
