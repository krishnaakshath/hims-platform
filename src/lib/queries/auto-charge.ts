// WS2 T9: the automatic charge seam (spec ruling 6). Every automatic charge (registration,
// consultation, lab order, procedure) is captured here, inside its caller's transaction,
// after the patient billing lock, which is taken LAST in visit transactions (spec section 6).
// It never throws for a business reason and never aborts the clinical act: a block or a
// missing price is returned as an outcome and no line is written.
import { and, asc, eq, inArray, isNull, max, ne, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { chargeLines, encounterProcedures, encounters, invoices, patients, providers, type ChargeLineRow, type EncounterRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import { isUniqueViolation } from '@/lib/db-errors'
import type { Session } from '@/lib/auth'
import type { ChargeRuleCode } from '@/lib/billing/charge-rules'
import type { ChargeCaptureInput } from '@/lib/billing/validation'
import { autoBillTo, planVisitCharges, type AutoChargeSource } from '@/lib/billing/visit-charges'
import { defaultEncounterVisitType } from '@/lib/encounters/status'
import { DEFAULT_TIMEZONE, todayIsoIn } from '@/lib/india-time'
import { resolvePrice } from '@/lib/tariff/resolve'
import { getBillingSettings } from './billing-settings'
import { captureInTx, loadChargeContext, lockPatientBilling, type ChargeContext, type ChargeContextRef } from './charge-capture'
import { consultationServiceIdFor } from './providers'
import { loadPricingContext } from './tariff'
import type { WriteExecutor } from './executor'

export type { AutoChargeSource } from '@/lib/billing/visit-charges'

export interface AutoChargeInput {
  context: ChargeContextRef
  serviceId: number
  quantity: number
  serviceDate: string
  source: AutoChargeSource
  links?: { labOrderId?: number; encounterProcedureId?: number }
}

export type AutoChargeOutcome =
  | { ok: true; source: AutoChargeSource; lineId: number; itemName: string; taxablePaise: number; billTo: 'self' | 'payer'; existing: boolean }
  | { ok: false; source: AutoChargeSource; reason: 'no_service' | 'no_context' | 'context_cancelled' | 'price_unresolved' | 'blocked'; rules?: ChargeRuleCode[] }

const AUTO_CHARGE_SAVEPOINT = 'auto_charge_capture'
const ORDER_LINKED_SOURCES: readonly AutoChargeSource[] = ['lab_order', 'procedure']

/** Payer-only rules: when only these block a payer line, the line falls back to self-pay (ruling 6 bill-to). */
const PAYER_ONLY_BLOCKS: readonly ChargeRuleCode[] = ['preauth_required', 'preauth_invalid']

const okOutcome = (source: AutoChargeSource, line: ChargeLineRow, existing: boolean): AutoChargeOutcome => ({
  ok: true, source, lineId: line.id, itemName: line.itemName, taxablePaise: line.taxablePaise, billTo: line.payerId === null ? 'self' : 'payer', existing,
})

/** The line this automatic charge already has (any status for an order link; live otherwise). */
async function findAutoLine(tx: WriteExecutor, input: AutoChargeInput, ctx: ChargeContext): Promise<ChargeLineRow | null> {
  const live = ne(chargeLines.status, 'void')
  let where
  if (input.links?.labOrderId !== undefined) where = eq(chargeLines.labOrderId, input.links.labOrderId)
  else if (input.links?.encounterProcedureId !== undefined) where = eq(chargeLines.encounterProcedureId, input.links.encounterProcedureId)
  else if (input.source === 'registration') where = and(eq(chargeLines.patientId, ctx.patientId), eq(chargeLines.source, 'registration'), live)
  else if (input.source === 'consultation' && ctx.encounterId !== null) where = and(eq(chargeLines.encounterId, ctx.encounterId), eq(chargeLines.source, 'consultation'), live)
  else return null
  const [line] = await tx.select().from(chargeLines).where(where).orderBy(chargeLines.id).limit(1)
  return line ?? null
}

/**
 * Captures one automatic charge on the caller's transaction. Idempotent: an existing line for the
 * same visit consultation, patient registration, lab order or procedure is returned with
 * `existing: true`. Runs with no overrides; bill-to follows `autoBillTo`. `tx` must be a
 * transaction (the insert runs under a savepoint).
 */
export async function captureAutoChargeInTx(tx: WriteExecutor, input: AutoChargeInput, session: Session, now: Date = new Date()): Promise<AutoChargeOutcome> {
  const { source } = input
  const ctx = await loadChargeContext(tx, input.context)
  if (!ctx) return { ok: false, source, reason: 'no_context' }
  if (ctx.cancelled) return { ok: false, source, reason: 'context_cancelled' }
  await lockPatientBilling(tx, ctx.patientId)

  const found = await findAutoLine(tx, input, ctx)
  if (found) {
    // An order is billed once (unique link); a voided order line is never re-captured.
    if (found.status === 'void') return { ok: false, source, reason: 'blocked', rules: [] }
    return okOutcome(source, found, true)
  }

  const billTo = autoBillTo(ctx)
  const capture: ChargeCaptureInput = {
    context: input.context, serviceId: input.serviceId, quantity: input.quantity, serviceDate: input.serviceDate,
    billTo: billTo === 'payer' ? 'payer' : 'patient',
  }
  // WS2 T10 fix round 1 (I2): an order-linked line is one billable act per order, so a deliberate
  // same-day repeat is not a duplicate; the unique link plus the lookup above make retries idempotent.
  // Registration and consultation keep every rule.
  const skipRules: readonly ChargeRuleCode[] = ORDER_LINKED_SOURCES.includes(source) ? ['duplicate_charge'] : []
  const opts = { source, links: input.links, overridesAllowed: false, skipRules }
  // WS2 T10: the insert runs under a savepoint. A unique violation (a line written by a path that
  // bypassed the billing lock) rolls back to it, leaving the caller's transaction usable, and the
  // line that won is returned as existing (spec section 6).
  const attempt = async (c: ChargeCaptureInput) => {
    await tx.execute(sql.raw(`savepoint ${AUTO_CHARGE_SAVEPOINT}`))
    try {
      const r = await captureInTx(tx, c, session, now, opts)
      await tx.execute(sql.raw(`release savepoint ${AUTO_CHARGE_SAVEPOINT}`))
      return r
    } catch (err) {
      await tx.execute(sql.raw(`rollback to savepoint ${AUTO_CHARGE_SAVEPOINT}`))
      await tx.execute(sql.raw(`release savepoint ${AUTO_CHARGE_SAVEPOINT}`))
      if (!isUniqueViolation(err)) throw err
      return null
    }
  }
  const raced = async (): Promise<AutoChargeOutcome> => {
    const line = await findAutoLine(tx, input, ctx)
    // A violation the lookup cannot explain is not a business outcome: surface it.
    if (!line) throw new Error('auto charge: unique violation without a matching line')
    if (line.status === 'void') return { ok: false, source, reason: 'blocked', rules: [] }
    return okOutcome(source, line, true)
  }
  let result = await attempt(capture)
  if (result === null) return raced()
  let fellBack: ChargeRuleCode[] | null = null
  if (!result.ok && result.error === 'blocked' && billTo === 'payer') {
    const blocks = (result.violations ?? []).filter((v) => v.severity === 'block').map((v) => v.code)
    if (blocks.length > 0 && blocks.every((c) => PAYER_ONLY_BLOCKS.includes(c))) {
      fellBack = blocks
      result = await attempt({ ...capture, billTo: 'patient' })
      if (result === null) return raced()
    }
  }
  if (!result.ok) {
    if (result.error === 'context_not_found') return { ok: false, source, reason: 'no_context' }
    if (result.error === 'context_cancelled') return { ok: false, source, reason: 'context_cancelled' }
    const rules = (result.violations ?? []).filter((v) => v.severity === 'block').map((v) => v.code)
    return { ok: false, source, reason: rules.includes('price_unresolved') ? 'price_unresolved' : 'blocked', rules }
  }
  if (fellBack) {
    await logAudit(session, 'billing: auto charge fell back to self-pay', ctx.patientId, `line=${result.line.id} rules=${fellBack.join(',')}`, tx)
  }
  return okOutcome(source, result.line, false)
}

// ---------- visit charges ----------

interface VisitFacts { hasLiveRegistrationLine: boolean; priorEncounterCount: number; lastChargedConsultDate: string | null }

/** What planVisitCharges needs to know about the patient's history, excluding `encounterId` itself. */
async function visitFacts(executor: WriteExecutor, patientId: string, departmentId: number | null, encounterId: number | null): Promise<VisitFacts> {
  const [reg] = await executor.select({ id: chargeLines.id }).from(chargeLines)
    .where(and(eq(chargeLines.patientId, patientId), eq(chargeLines.source, 'registration'), ne(chargeLines.status, 'void'))).limit(1)
  const [prior] = await executor.select({ n: sql<number>`count(*)::int` }).from(encounters).where(and(
    eq(encounters.patientId, patientId), ne(encounters.status, 'cancelled'),
    encounterId === null ? undefined : ne(encounters.id, encounterId),
  ))
  let lastChargedConsultDate: string | null = null
  if (departmentId !== null) {
    const [last] = await executor.select({ d: max(chargeLines.serviceDate) }).from(chargeLines)
      .innerJoin(encounters, eq(encounters.id, chargeLines.encounterId))
      .where(and(
        eq(chargeLines.patientId, patientId), eq(chargeLines.source, 'consultation'), ne(chargeLines.status, 'void'),
        eq(encounters.departmentId, departmentId),
        encounterId === null ? undefined : ne(chargeLines.encounterId, encounterId),
      ))
    lastChargedConsultDate = last?.d ?? null
  }
  return { hasLiveRegistrationLine: !!reg, priorEncounterCount: prior?.n ?? 0, lastChargedConsultDate }
}

async function consultationOutcome(tx: WriteExecutor, encounter: EncounterRow, session: Session, now: Date): Promise<AutoChargeOutcome> {
  const serviceId = encounter.departmentId === null ? null : await consultationServiceIdFor(tx, encounter.departmentId)
  if (serviceId === null) return { ok: false, source: 'consultation', reason: 'no_service' }
  return captureAutoChargeInTx(tx, {
    context: { encounterId: encounter.id }, serviceId, quantity: 1, serviceDate: encounter.encounterDate, source: 'consultation',
  }, session, now)
}

/**
 * Check-in (OPD only): the consultation, then the registration fee at the patient's first visit.
 * Registration is skipped silently when billing_settings.registration_service_id is not set.
 * Takes the patient billing lock before reading the history, so two check-ins serialise.
 */
export async function captureVisitChargesInTx(tx: WriteExecutor, encounter: EncounterRow, session: Session, now: Date): Promise<AutoChargeOutcome[]> {
  if (encounter.encounterType !== 'opd') return []
  await lockPatientBilling(tx, encounter.patientId)
  const settings = await getBillingSettings(tx)
  const facts = await visitFacts(tx, encounter.patientId, encounter.departmentId, encounter.id)
  const plan = planVisitCharges({
    encounterType: encounter.encounterType, visitType: encounter.visitType, encounterDate: encounter.encounterDate,
    departmentId: encounter.departmentId, freeReviewDays: settings.freeReviewDays, ...facts,
  })
  const out: AutoChargeOutcome[] = []
  if (plan.consultation) out.push(await consultationOutcome(tx, encounter, session, now))
  if (plan.registration && settings.registrationServiceId !== null) {
    out.push(await captureAutoChargeInTx(tx, {
      context: { encounterId: encounter.id }, serviceId: settings.registrationServiceId, quantity: 1, serviceDate: encounter.encounterDate, source: 'registration',
    }, session, now))
  }
  return out
}

/**
 * Completion (OPD only): captures the consultation if it is still missing (e.g. billing added the
 * rate after check-in). Null when the visit owes no consultation (free review, no department).
 */
export async function ensureConsultationChargeInTx(tx: WriteExecutor, encounter: EncounterRow, session: Session, now: Date): Promise<AutoChargeOutcome | null> {
  if (encounter.encounterType !== 'opd') return null
  await lockPatientBilling(tx, encounter.patientId)
  const settings = await getBillingSettings(tx)
  const facts = await visitFacts(tx, encounter.patientId, encounter.departmentId, encounter.id)
  const plan = planVisitCharges({
    encounterType: encounter.encounterType, visitType: encounter.visitType, encounterDate: encounter.encounterDate,
    departmentId: encounter.departmentId, freeReviewDays: settings.freeReviewDays, ...facts,
  })
  if (!plan.consultation) return null
  return consultationOutcome(tx, encounter, session, now)
}

const VISIT_SOURCES = ['registration', 'consultation'] as const
const VISIT_CANCELLED_REASON = 'Visit cancelled'

/**
 * Cancel: voids the visit's live consultation and lab-order lines (WS2 T10: lab lines billed to the
 * visit, not to a stay), its procedure lines (WS2 T11) and its registration line (a draft invoice loses them, the SP4 void rule).
 * WS2 T10: the registration fee is owed once per patient, so while the patient has another
 * non-cancelled encounter the registration line moves to the earliest of them instead of being
 * voided. A line on a finalised invoice is never touched: the whole cancel is refused with that
 * invoice's number, and nothing is changed. Runs under the patient billing lock; encounters are
 * read, never locked.
 */
export async function voidAutoLinesForEncounterInTx(
  tx: WriteExecutor, encounterId: number, session: Session,
): Promise<{ ok: true; voided: number } | { ok: false; error: 'visit_billed'; invoiceNumber: string }> {
  const [enc] = await tx.select({ patientId: encounters.patientId }).from(encounters).where(eq(encounters.id, encounterId)).limit(1)
  if (!enc) return { ok: true, voided: 0 }
  await lockPatientBilling(tx, enc.patientId)
  const lines = await tx.select({ id: chargeLines.id, source: chargeLines.source, status: chargeLines.status, invoiceNumber: invoices.invoiceNumber })
    .from(chargeLines).leftJoin(invoices, eq(invoices.id, chargeLines.invoiceId))
    .where(and(
      eq(chargeLines.encounterId, encounterId), ne(chargeLines.status, 'void'),
      or(
        inArray(chargeLines.source, [...VISIT_SOURCES]),
        and(eq(chargeLines.source, 'lab_order'), isNull(chargeLines.admissionId)),
        // WS2 T11: the lines of the visit's procedures (linked by procedure, whatever the context).
        and(eq(chargeLines.source, 'procedure'), inArray(chargeLines.encounterProcedureId,
          tx.select({ id: encounterProcedures.id }).from(encounterProcedures).where(eq(encounterProcedures.encounterId, encounterId)))),
      ),
    ))
    .orderBy(chargeLines.id)
    .for('update', { of: chargeLines })
  const billed = lines.find((l) => l.status === 'invoiced')
  if (billed) return { ok: false, error: 'visit_billed', invoiceNumber: billed.invoiceNumber ?? '' }
  const at = new Date()
  let voided = 0
  for (const l of lines) {
    if (l.source === 'registration') {
      const [next] = await tx.select({ id: encounters.id, admissionId: encounters.admissionId, encounterDate: encounters.encounterDate }).from(encounters)
        .where(and(eq(encounters.patientId, enc.patientId), ne(encounters.id, encounterId), ne(encounters.status, 'cancelled')))
        .orderBy(asc(encounters.encounterDate), asc(encounters.id)).limit(1)
      if (next) {
        await tx.update(chargeLines).set({ encounterId: next.id, admissionId: next.admissionId, serviceDate: next.encounterDate, invoiceId: null })
          .where(eq(chargeLines.id, l.id))
        await logAudit(session, 'billing: moved registration line', enc.patientId, `line=${l.id} from=${encounterId} to=${next.id}`, tx)
        continue
      }
    }
    await tx.update(chargeLines).set({ status: 'void', voidReason: VISIT_CANCELLED_REASON, voidedAt: at, voidedByName: session.name, invoiceId: null })
      .where(eq(chargeLines.id, l.id))
    await logAudit(session, 'billing: voided charge line', enc.patientId, `line=${l.id} encounter=${encounterId} cause=visit_cancelled`, tx)
    voided++
  }
  return { ok: true, voided }
}

// ---------- fee preview (check-in dialog) ----------

export interface FeePreview {
  registration: { itemName: string; amountPaise: number } | null
  consultation: { itemName: string; amountPaise: number } | null
  note: 'no_rate' | 'no_department' | 'free_review' | 'inpatient' | null
}

async function priceToday(serviceId: number, departmentId: number | null, today: string): Promise<{ itemName: string; amountPaise: number } | null> {
  const pricing = await loadPricingContext(serviceId)
  if (!pricing.service || !pricing.service.isActive) return null
  const price = resolvePrice({ serviceId, departmentId: departmentId ?? undefined, onDate: today }, pricing)
  return price.ok ? { itemName: pricing.service.name, amountPaise: price.amountPaise } : null
}

/** What a check-in would charge now (self-pay base/department price; never writes). */
export async function checkInFeePreview(i: {
  patientId: string; providerId: number; visitType: 'inpatient' | 'outpatient'; urgency: 'routine' | 'urgent' | 'emergency'
}, now: Date = new Date()): Promise<FeePreview> {
  if (i.visitType === 'inpatient') return { registration: null, consultation: null, note: 'inpatient' }
  const db = getDb()
  const today = todayIsoIn(DEFAULT_TIMEZONE, now)
  const [prov] = await db.select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, i.providerId)).limit(1)
  const departmentId = prov?.departmentId ?? null
  const settings = await getBillingSettings(db)
  const facts = await visitFacts(db, i.patientId, departmentId, null)
  const plan = planVisitCharges({
    encounterType: 'opd', visitType: defaultEncounterVisitType({ urgency: i.urgency, followUpLinked: false }), encounterDate: today,
    departmentId, freeReviewDays: settings.freeReviewDays, ...facts,
  })
  const registration = plan.registration && settings.registrationServiceId !== null
    ? await priceToday(settings.registrationServiceId, departmentId, today) : null
  let consultation: FeePreview['consultation'] = null
  let note: FeePreview['note'] = null
  if (plan.consultation && departmentId !== null) {
    const serviceId = await consultationServiceIdFor(db, departmentId)
    consultation = serviceId === null ? null : await priceToday(serviceId, departmentId, today)
    if (consultation === null) note = 'no_rate'
  } else if (plan.consultationSkip === 'no_department' || plan.consultationSkip === 'free_review') {
    note = plan.consultationSkip
  }
  return { registration, consultation, note }
}

/** True when the patient exists (the preview route answers 404 otherwise). */
export async function patientExists(patientId: string): Promise<boolean> {
  const [p] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, patientId)).limit(1)
  return !!p
}
