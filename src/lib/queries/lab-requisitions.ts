// SP5 doctor's order: one lab_requisitions row grouping the tests a doctor orders together
// (Ruling 7), one lab_orders row per test carrying the price quoted from the SP2 tariff master
// on the IST order date (Ruling 11), and the optional "follow-up after the report" request.
//
// Reads and price quotes happen before the transaction; the requisition, its orders and one
// audit row per order are written in ONE transaction (lock order: requisition → lab_orders; the
// rows are new, so nothing is contended). The local-patient notice is the route's job, after
// commit.
import { asc, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { labOrders, labRequisitions, labTests, patients, providers, type LabOrderRow, type LabRequisitionRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { istDateOf } from '@/lib/india-time'
import { quoteFromResolution, type LabQuote, type LabQuoteStatus } from '@/lib/labs/catalog'
import type { CreateLabRequisitionRequest } from '@/lib/labs/validation'
import { getEncounterById } from '@/lib/queries/encounters'
import { isLocalPatientPin } from '@/lib/queries/lab-setup'
import { loadPricingContext } from '@/lib/queries/tariff'
import { resolvePrice } from '@/lib/tariff/resolve'

export interface CreateLabRequisitionInput extends CreateLabRequisitionRequest {
  patientId: string
  orderedByProviderId: number
}

export type QuotedLine = { orderId: number; labTestId: number; quotedPricePaise: number | null; quoteStatus: LabQuoteStatus }

export type CreateLabRequisitionResult =
  | { ok: true; requisition: LabRequisitionRow; lines: QuotedLine[]; patientIsLocal: boolean }
  | { ok: false; error: 'patient_not_found' | 'test_not_found' | 'encounter_not_found' | 'encounter_mismatch' }

export async function createLabRequisition(input: CreateLabRequisitionInput, session: Session, now = new Date()): Promise<CreateLabRequisitionResult> {
  const db = getDb()
  const onDate = istDateOf(now)

  // 1. Reads (named columns only).
  const [patient] = await db
    .select({ pinCode: patients.pinCode, primaryPayerId: patients.primaryPayerId })
    .from(patients)
    .where(eq(patients.id, input.patientId))
  if (!patient) return { ok: false, error: 'patient_not_found' }

  const testRows = await db.select({ id: labTests.id, serviceId: labTests.serviceId }).from(labTests).where(inArray(labTests.id, input.labTestIds))
  const serviceByTest = new Map(testRows.map((t) => [t.id, t.serviceId]))
  if (input.labTestIds.some((id) => !serviceByTest.has(id))) return { ok: false, error: 'test_not_found' }

  if (input.originatingEncounterId !== null) {
    const encounter = await getEncounterById(input.originatingEncounterId)
    if (!encounter) return { ok: false, error: 'encounter_not_found' }
    if (encounter.patientId !== input.patientId) return { ok: false, error: 'encounter_mismatch' }
  }

  const [provider] = await db.select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, input.orderedByProviderId))
  const providerDept = provider?.departmentId ?? null

  // 2. Quotes (SP2 resolver: payer > department > base, on the IST order date).
  const quotes = new Map<number, LabQuote>()
  for (const labTestId of input.labTestIds) {
    const serviceId = serviceByTest.get(labTestId) ?? null
    if (serviceId === null) {
      quotes.set(labTestId, quoteFromResolution(null))
      continue
    }
    const res = resolvePrice(
      { serviceId, payerId: patient.primaryPayerId ?? undefined, departmentId: providerDept ?? undefined, onDate },
      await loadPricingContext(serviceId),
    )
    quotes.set(labTestId, quoteFromResolution(res))
  }

  // 3. One transaction: requisition, one order per test (input order), one audit per order.
  const { requisition, lines } = await db.transaction(async (tx) => {
    const [req] = await tx
      .insert(labRequisitions)
      .values({
        patientId: input.patientId,
        orderedByProviderId: input.orderedByProviderId,
        originatingEncounterId: input.originatingEncounterId,
        followUpRequested: input.followUp !== null,
        followUpIntervalValue: input.followUp?.interval.value ?? null,
        followUpIntervalUnit: input.followUp?.interval.unit ?? null,
        followUpReason: input.followUp?.reason ?? null,
        createdByName: session.name,
        createdByUserId: session.userId ?? null,
      })
      .returning()
    const out: QuotedLine[] = []
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
      out.push({ orderId: order.id, labTestId, quotedPricePaise: quote.quotedPricePaise, quoteStatus: quote.quoteStatus })
    }
    return { requisition: req, lines: out }
  })

  // 4. Local patient (Ruling 3: the registered SP1 PIN against the active service-area list).
  const patientIsLocal = await isLocalPatientPin(patient.pinCode)
  return { ok: true, requisition, lines, patientIsLocal }
}

export async function getRequisitionWithOrders(id: number): Promise<{ requisition: LabRequisitionRow; orders: LabOrderRow[] } | null> {
  const db = getDb()
  const [requisition] = await db.select().from(labRequisitions).where(eq(labRequisitions.id, id))
  if (!requisition) return null
  const orders = await db.select().from(labOrders).where(eq(labOrders.requisitionId, id)).orderBy(asc(labOrders.id))
  return { requisition, orders }
}
