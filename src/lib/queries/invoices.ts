// SP4: the invoice lifecycle. draft → finalised (numbered, snapshotted, totalled) → cancelled by a
// full-value credit note; or draft → discarded. Every write takes the per-patient billing lock first
// and writes its audit row on the same transaction. Issued rows are also guarded by migration-B triggers.
import { and, asc, count, desc, eq, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  chargeLines, creditNotes, invoiceLines, invoices, patients, payers,
  type ChargeLineRow, type CreditNoteRow, type InvoiceLineRow, type InvoiceRow,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { sumPaise } from '@/lib/billing/amounts'
import {
  GST_STATE_CODES, documentTitle, lineTax, placeOfSupply, stateCodeOfGstin, type InvoiceSnapshot, type SupplyType,
} from '@/lib/billing/gst'
import { financialYearOf } from '@/lib/billing/numbering'
import { istDateOf } from '@/lib/india-time'
import { getBillingSettings } from './billing-settings'
import { lockPatientBilling } from './charge-capture'
import { SeriesExhaustedError, allocateDocumentNumber } from './document-numbers'

export type InvoiceStatus = InvoiceRow['status']

async function invoicePatient(invoiceId: number): Promise<string | null> {
  const [row] = await getDb().select({ patientId: invoices.patientId }).from(invoices).where(eq(invoices.id, invoiceId)).limit(1)
  return row?.patientId ?? null
}

// ---------- drafts ----------

export async function createDraftInvoice(
  lineIds: number[], session: Session,
): Promise<{ ok: true; invoiceId: number } | { ok: false; error: 'lines_not_found' | 'lines_not_available' | 'mixed_lines' }> {
  const ids = [...new Set(lineIds)]
  const pre = await getDb().select({ patientId: chargeLines.patientId }).from(chargeLines).where(inArray(chargeLines.id, ids))
  if (pre.length !== ids.length) return { ok: false, error: 'lines_not_found' }
  const patientIds = new Set(pre.map((r) => r.patientId))
  if (patientIds.size !== 1) return { ok: false, error: 'mixed_lines' }
  const patientId = pre[0].patientId

  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, patientId)
    const lines = await tx.select().from(chargeLines).where(inArray(chargeLines.id, ids)).orderBy(asc(chargeLines.id)).for('update')
    if (lines.length !== ids.length) return { ok: false as const, error: 'lines_not_found' as const }
    if (lines.some((l) => l.status !== 'captured' || l.invoiceId !== null)) return { ok: false as const, error: 'lines_not_available' as const }
    // One patient, one payer (null = self-pay counts), one context: the same admission when any line
    // has one, else the same encounter (pharmacy lines with neither form their own group).
    const same = <T>(values: T[]) => values.every((v) => v === values[0])
    if (!same(lines.map((l) => l.patientId)) || !same(lines.map((l) => l.payerId))) return { ok: false as const, error: 'mixed_lines' as const }
    const anyAdmission = lines.some((l) => l.admissionId !== null)
    if (anyAdmission ? !same(lines.map((l) => l.admissionId)) : !same(lines.map((l) => l.encounterId))) {
      return { ok: false as const, error: 'mixed_lines' as const }
    }
    const encounterIds = lines.map((l) => l.encounterId)
    const [invoice] = await tx.insert(invoices).values({
      patientId,
      admissionId: anyAdmission ? lines[0].admissionId : null,
      encounterId: same(encounterIds) ? encounterIds[0] : null,
      payerId: lines[0].payerId,
      createdByName: session.name,
    }).returning({ id: invoices.id })
    await tx.update(chargeLines).set({ invoiceId: invoice.id }).where(inArray(chargeLines.id, ids))
    await logAudit(session, 'billing: created draft invoice', patientId, `invoice=${invoice.id} lines=${ids.length}`, tx)
    return { ok: true as const, invoiceId: invoice.id }
  })
}

export async function discardDraftInvoice(invoiceId: number, session: Session): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_draft' }> {
  const patientId = await invoicePatient(invoiceId)
  if (patientId === null) return { ok: false, error: 'not_found' }
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, patientId)
    const [inv] = await tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId)).for('update')
    if (!inv) return { ok: false as const, error: 'not_found' as const }
    if (inv.status !== 'draft') return { ok: false as const, error: 'not_draft' as const }
    await tx.update(chargeLines).set({ invoiceId: null }).where(eq(chargeLines.invoiceId, invoiceId))
    await tx.update(invoices).set({ status: 'discarded', discardedAt: new Date(), discardedByName: session.name }).where(eq(invoices.id, invoiceId))
    await logAudit(session, 'billing: discarded draft invoice', patientId, `invoice=${invoiceId}`, tx)
    return { ok: true as const }
  })
}

// ---------- finalise ----------

type FinaliseError = 'not_found' | 'not_draft' | 'empty' | 'settings_incomplete' | 'taxable_without_gstin' | 'series_exhausted'

/** Recipient state for the place of supply: the payer's state, else its GSTIN's, else the patient's. */
function recipientStateOf(payer: { gstin: string | null; stateCode: string | null } | null, patientState: string | null): string | null {
  if (payer?.stateCode) return payer.stateCode
  const fromGstin = payer?.gstin ? stateCodeOfGstin(payer.gstin) : null
  return fromGstin ?? patientState
}

function contextLabel(inv: { admissionId: number | null; encounterId: number | null }): string {
  if (inv.admissionId !== null) return `Inpatient stay (admission ${inv.admissionId})`
  if (inv.encounterId !== null) return `Outpatient visit (visit ${inv.encounterId})`
  return 'Pharmacy'
}

type Settings = Awaited<ReturnType<typeof getBillingSettings>>

/** The bill-to parties from the current masters: frozen into the snapshot at finalisation, shown live on drafts. */
async function liveParties(
  executor: Pick<ReturnType<typeof getDb>, 'select'>, inv: Pick<InvoiceRow, 'patientId' | 'payerId' | 'encounterId' | 'admissionId'>, settings: Settings,
): Promise<{ parties: InvoiceSnapshot; recipientState: string | null }> {
  // Named patient columns only: id, name, UHID and postal address.
  const [patient] = await executor.select({
    id: patients.id, name: patients.name, uhid: patients.uhid, addressLine1: patients.addressLine1, addressLine2: patients.addressLine2,
    city: patients.city, district: patients.district, stateCode: patients.stateCode, pinCode: patients.pinCode,
  }).from(patients).where(eq(patients.id, inv.patientId))
  const [payer] = inv.payerId === null ? [] : await executor.select({ id: payers.id, name: payers.name, gstin: payers.gstin, stateCode: payers.stateCode })
    .from(payers).where(eq(payers.id, inv.payerId))
  const stateCode = settings.stateCode ?? ''
  return {
    parties: {
      hospital: { legalName: settings.legalName ?? '', gstin: settings.gstin, stateCode, gstStateCode: GST_STATE_CODES[stateCode] ?? '', address: settings.address },
      patient: {
        id: patient.id, name: patient.name, uhid: patient.uhid, addressLine1: patient.addressLine1, addressLine2: patient.addressLine2,
        city: patient.city, district: patient.district, stateCode: patient.stateCode, pinCode: patient.pinCode,
      },
      payer: payer ? { id: payer.id, name: payer.name, gstin: payer.gstin, stateCode: payer.stateCode } : null,
      context: { encounterId: inv.encounterId, admissionId: inv.admissionId, label: contextLabel(inv) },
    },
    recipientState: recipientStateOf(payer ?? null, patient.stateCode),
  }
}

/**
 * Numbers, snapshots and totals a draft. The number is drawn only after every check, inside the
 * same transaction as the update, so a failure leaves the draft and burns no number.
 * `hooks.afterNumber` is a test seam only; no app caller passes it.
 */
export async function finaliseInvoice(
  invoiceId: number, session: Session, now: Date = new Date(), hooks: { afterNumber?: () => void } = {},
): Promise<{ ok: true; invoiceNumber: string } | { ok: false; error: FinaliseError }> {
  const patientId = await invoicePatient(invoiceId)
  if (patientId === null) return { ok: false, error: 'not_found' }
  try {
    return await getDb().transaction(async (tx) => {
      await lockPatientBilling(tx, patientId)
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update')
      if (!inv) return { ok: false as const, error: 'not_found' as const }
      if (inv.status !== 'draft') return { ok: false as const, error: 'not_draft' as const }
      const lines = await tx.select().from(chargeLines).where(and(eq(chargeLines.invoiceId, invoiceId), eq(chargeLines.status, 'captured')))
        .orderBy(asc(chargeLines.serviceDate), asc(chargeLines.id)).for('update')
      if (lines.length === 0) return { ok: false as const, error: 'empty' as const }

      const settings = await getBillingSettings(tx)
      if (!settings.legalName || !settings.stateCode) return { ok: false as const, error: 'settings_incomplete' as const }
      if (!settings.gstin && lines.some((l) => l.gstRateBp > 0)) return { ok: false as const, error: 'taxable_without_gstin' as const }

      const { parties: snapshot, recipientState: recipient } = await liveParties(tx, inv, settings)
      const pos = placeOfSupply({ mode: settings.placeOfSupplyMode, hospitalStateCode: settings.stateCode, recipientStateCode: recipient })

      const invoiceDate = istDateOf(now)
      const fy = financialYearOf(invoiceDate)
      const taxed = lines.map((l) => ({ line: l, tax: lineTax(l.taxablePaise, l.gstRateBp, pos.supplyType) }))
      await tx.insert(invoiceLines).values(taxed.map(({ line: l, tax }, i) => ({
        invoiceId, chargeLineId: l.id, lineNo: i + 1, itemCode: l.itemCode, itemName: l.itemName, hsnSac: l.hsnSac, serviceDate: l.serviceDate,
        quantity: l.quantity, unitPricePaise: l.unitPricePaise, priceSource: l.priceSource, taxablePaise: l.taxablePaise, gstRateBp: l.gstRateBp,
        cgstRateBp: tax.cgstRateBp, sgstRateBp: tax.sgstRateBp, igstRateBp: tax.igstRateBp,
        cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, totalPaise: tax.totalPaise,
      })))
      const total = (pick: (t: (typeof taxed)[number]) => number) => sumPaise(taxed.map(pick))
      const invoiceNumber = await allocateDocumentNumber(tx, 'invoice', fy)
      hooks.afterNumber?.()
      const totalPaise = total((t) => t.tax.totalPaise)
      await tx.update(invoices).set({
        status: 'finalised', invoiceNumber, financialYear: fy, invoiceDate, documentTitle: documentTitle(lines.map((l) => l.gstRateBp), settings.gstin),
        supplyType: pos.supplyType, placeOfSupplyStateCode: pos.stateCode, snapshot,
        taxablePaise: total((t) => t.line.taxablePaise), cgstPaise: total((t) => t.tax.cgstPaise), sgstPaise: total((t) => t.tax.sgstPaise),
        igstPaise: total((t) => t.tax.igstPaise), totalPaise, finalisedAt: now, finalisedByName: session.name,
      }).where(eq(invoices.id, invoiceId))
      await tx.update(chargeLines).set({ status: 'invoiced' }).where(inArray(chargeLines.id, lines.map((l) => l.id)))
      await logAudit(session, 'billing: finalised invoice', inv.patientId, `invoice=${invoiceId} number=${invoiceNumber} total=${totalPaise}`, tx)
      return { ok: true as const, invoiceNumber }
    })
  } catch (err) {
    if (err instanceof SeriesExhaustedError) return { ok: false, error: 'series_exhausted' }
    throw err
  }
}

// ---------- cancel ----------

export async function cancelInvoice(
  invoiceId: number, reason: string, session: Session, now: Date = new Date(),
): Promise<{ ok: true; creditNoteNumber: string } | { ok: false; error: 'not_found' | 'not_finalised' | 'on_claim' }> {
  const patientId = await invoicePatient(invoiceId)
  if (patientId === null) return { ok: false, error: 'not_found' }
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, patientId)
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId)).for('update')
    if (!inv) return { ok: false as const, error: 'not_found' as const }
    if (inv.status !== 'finalised') return { ok: false as const, error: 'not_finalised' as const }
    // SP7 (ruling 2): no credit note while the invoice is on a claim beyond draft/withdrawn.
    const onClaim = await tx.execute<{ found: boolean }>(sql`select exists (select 1 from claim_invoices ci join claims c on c.id = ci.claim_id
      where ci.invoice_id = ${invoiceId} and c.status not in ('draft', 'withdrawn')) as found`)
    if (onClaim.rows[0]?.found) return { ok: false as const, error: 'on_claim' as const }
    // end SP7
    const issueDate = istDateOf(now)
    const fy = financialYearOf(issueDate)
    const creditNoteNumber = await allocateDocumentNumber(tx, 'credit_note', fy)
    await tx.insert(creditNotes).values({
      creditNoteNumber, invoiceId, financialYear: fy, issueDate, reason: reason.trim(),
      taxablePaise: inv.taxablePaise ?? 0, cgstPaise: inv.cgstPaise ?? 0, sgstPaise: inv.sgstPaise ?? 0, igstPaise: inv.igstPaise ?? 0, totalPaise: inv.totalPaise ?? 0,
      issuedByName: session.name, issuedAt: now,
    })
    // The one change the invoices_issued_guard trigger allows on a finalised invoice.
    await tx.update(invoices).set({ status: 'cancelled', cancelledAt: now, cancelledByName: session.name }).where(eq(invoices.id, invoiceId))
    await tx.update(chargeLines).set({ status: 'captured', invoiceId: null }).where(eq(chargeLines.invoiceId, invoiceId))
    await logAudit(session, 'billing: cancelled invoice by credit note', inv.patientId, `invoice=${invoiceId} credit_note=${creditNoteNumber}`, tx)
    return { ok: true as const, creditNoteNumber }
  })
}

// ---------- reads ----------

export type InvoiceDetailLine = Pick<InvoiceLineRow,
  'lineNo' | 'chargeLineId' | 'itemCode' | 'itemName' | 'hsnSac' | 'serviceDate' | 'quantity' | 'unitPricePaise' | 'priceSource' | 'taxablePaise'
  | 'gstRateBp' | 'cgstRateBp' | 'sgstRateBp' | 'igstRateBp' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'totalPaise'>

export type InvoiceDetail = InvoiceRow & {
  lines: InvoiceDetailLine[]
  creditNote: CreditNoteRow | null
  patientName: string
  uhid: string | null
  /** True for a draft: its lines carry an estimated split from the current settings. */
  estimated: boolean
  /** The snapshot for an issued invoice; the current masters for a draft. */
  parties: InvoiceSnapshot
  /** Place of supply: stored when issued, estimated for a draft (stateCode null until the hospital state is set). */
  place: { stateCode: string | null; supplyType: SupplyType }
}

export async function getInvoice(id: number): Promise<InvoiceDetail | null> {
  const db = getDb()
  const [row] = await db.select({ invoice: invoices, patientName: patients.name, uhid: patients.uhid })
    .from(invoices).innerJoin(patients, eq(patients.id, invoices.patientId)).where(eq(invoices.id, id)).limit(1)
  if (!row) return null
  const inv = row.invoice
  const [creditNote] = await db.select().from(creditNotes).where(eq(creditNotes.invoiceId, id)).limit(1)
  const estimated = inv.status === 'draft' || inv.status === 'discarded'
  if (!estimated) {
    const lines = await db.select({
      lineNo: invoiceLines.lineNo, chargeLineId: invoiceLines.chargeLineId, itemCode: invoiceLines.itemCode, itemName: invoiceLines.itemName,
      hsnSac: invoiceLines.hsnSac, serviceDate: invoiceLines.serviceDate, quantity: invoiceLines.quantity, unitPricePaise: invoiceLines.unitPricePaise,
      priceSource: invoiceLines.priceSource, taxablePaise: invoiceLines.taxablePaise, gstRateBp: invoiceLines.gstRateBp, cgstRateBp: invoiceLines.cgstRateBp,
      sgstRateBp: invoiceLines.sgstRateBp, igstRateBp: invoiceLines.igstRateBp, cgstPaise: invoiceLines.cgstPaise, sgstPaise: invoiceLines.sgstPaise,
      igstPaise: invoiceLines.igstPaise, totalPaise: invoiceLines.totalPaise,
    }).from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.lineNo))
    const parties = inv.snapshot ?? (await liveParties(db, inv, await getBillingSettings(db))).parties
    return {
      ...inv, lines, creditNote: creditNote ?? null, patientName: row.patientName, uhid: row.uhid, estimated,
      parties, place: { stateCode: inv.placeOfSupplyStateCode, supplyType: inv.supplyType ?? 'intra' },
    }
  }
  const attached = await db.select().from(chargeLines).where(and(eq(chargeLines.invoiceId, id), eq(chargeLines.status, 'captured')))
    .orderBy(asc(chargeLines.serviceDate), asc(chargeLines.id))
  const settings = await getBillingSettings(db)
  const { parties, recipientState } = await liveParties(db, inv, settings)
  const place = settings.stateCode
    ? placeOfSupply({ mode: settings.placeOfSupplyMode, hospitalStateCode: settings.stateCode, recipientStateCode: recipientState })
    : { stateCode: null, supplyType: 'intra' as SupplyType }
  const lines = attached.map((l, i) => {
    const t = lineTax(l.taxablePaise, l.gstRateBp, place.supplyType)
    return {
      lineNo: i + 1, chargeLineId: l.id, itemCode: l.itemCode, itemName: l.itemName, hsnSac: l.hsnSac, serviceDate: l.serviceDate, quantity: l.quantity,
      unitPricePaise: l.unitPricePaise, priceSource: l.priceSource, taxablePaise: l.taxablePaise, gstRateBp: l.gstRateBp,
      cgstRateBp: t.cgstRateBp, sgstRateBp: t.sgstRateBp, igstRateBp: t.igstRateBp, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise, igstPaise: t.igstPaise, totalPaise: t.totalPaise,
    }
  })
  return { ...inv, lines, creditNote: creditNote ?? null, patientName: row.patientName, uhid: row.uhid, estimated, parties, place }
}

export interface InvoiceListRow {
  id: number
  invoiceNumber: string | null
  status: InvoiceStatus
  patientId: string
  patientName: string
  uhid: string | null
  payerName: string | null
  invoiceDate: string | null
  totalPaise: number | null
  createdAt: Date
}

export const INVOICE_PAGE_SIZE = 50

/** `q` matches an invoice number prefix or an exact UHID. Newest first, 50 per page. */
export async function listInvoices(opts: { status?: InvoiceStatus; q?: string; page?: number } = {}): Promise<{ rows: InvoiceListRow[]; total: number }> {
  const db = getDb()
  const conditions: SQL[] = []
  if (opts.status) conditions.push(eq(invoices.status, opts.status))
  const q = opts.q?.trim()
  if (q) {
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`)
    conditions.push(or(like(invoices.invoiceNumber, `${escaped}%`), eq(patients.uhid, q))!)
  }
  const where = conditions.length ? and(...conditions) : undefined
  const page = Math.max(1, Math.trunc(opts.page ?? 1))
  const rows = await db.select({
    id: invoices.id, invoiceNumber: invoices.invoiceNumber, status: invoices.status, patientId: invoices.patientId, patientName: patients.name,
    uhid: patients.uhid, payerName: payers.name, invoiceDate: invoices.invoiceDate, totalPaise: invoices.totalPaise, createdAt: invoices.createdAt,
  }).from(invoices).innerJoin(patients, eq(patients.id, invoices.patientId)).leftJoin(payers, eq(payers.id, invoices.payerId)).where(where)
    .orderBy(desc(invoices.createdAt), desc(invoices.id)).limit(INVOICE_PAGE_SIZE).offset((page - 1) * INVOICE_PAGE_SIZE)
  const [{ n }] = await db.select({ n: count() }).from(invoices).innerJoin(patients, eq(patients.id, invoices.patientId)).where(where)
  return { rows, total: n }
}

/** Captured lines of a visit or stay that are not on any invoice yet. */
export async function listCapturedLinesForContext(ref: { encounterId: number } | { admissionId: number }): Promise<ChargeLineRow[]> {
  const ctx = 'admissionId' in ref ? eq(chargeLines.admissionId, ref.admissionId) : eq(chargeLines.encounterId, ref.encounterId)
  return getDb().select().from(chargeLines).where(and(ctx, eq(chargeLines.status, 'captured'), isNull(chargeLines.invoiceId)))
    .orderBy(asc(chargeLines.serviceDate), asc(chargeLines.id))
}
