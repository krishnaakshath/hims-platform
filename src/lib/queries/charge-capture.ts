// SP4: charge capture. Context loading, preview, capture and void of charge lines.
// Capture runs in one transaction that first takes the per-patient billing lock, so two clerks
// (or a double click) adding the same charge serialise and the second sees the first.
import { and, asc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, chargeLines, departments, encounters, patientPayments, patients, payers, providers, refunds, roomCategories, rooms, serviceCatalog,
  type ChargeLineRow, PRICE_SOURCES,
} from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import { BILLING_AUTHORITY_ROLES } from '@/lib/role-policy'
import { lineTaxablePaise, paiseFromDb } from '@/lib/billing/amounts'
import {
  appliedOverrides, evaluateChargeRules, unresolvedBlocks,
  type ChargeRuleCode, type ChargeRuleInput, type ChargeViolation, type ProcedureCodeRef,
} from '@/lib/billing/charge-rules'
import { lineTax, placeOfSupply, stateCodeOfGstin, type LineTax } from '@/lib/billing/gst'
import { admissionDepositPaise, type LedgerEntry } from '@/lib/billing/ledger'
import type { ChargeCaptureInput } from '@/lib/billing/validation'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { DEFAULT_TIMEZONE, formatIsoDate, istDateOf, todayIsoIn } from '@/lib/india-time'
import { resolvePrice, type PriceResolution, type ServiceForPricing, type TariffRateCandidate } from '@/lib/tariff/resolve'
import { loadPricingContext } from './tariff'
import { validatePreauthReference } from './preauth-reference' // SP7
import { getBillingSettings, getRuleConfig } from './billing-settings'
import { loadMappedProcedureCodes } from './service-code-lookup'
import type { WriteExecutor } from './executor'

export type PriceSource = (typeof PRICE_SOURCES)[number]

/**
 * The per-patient billing lock (`billing:patient:<id>`), held to the end of the caller's
 * transaction. Every SP4 write for a patient (capture, room rent, finalise, payment, refund)
 * takes it first, so they serialise per patient.
 */
export async function lockPatientBilling(executor: Pick<WriteExecutor, 'execute'>, patientId: string): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtext(${`billing:patient:${patientId}`}))`)
}

export interface ChargeContext {
  kind: 'encounter' | 'admission'
  patientId: string
  encounterId: number | null
  admissionId: number | null
  departmentId: number | null
  orderingProviderId: number
  startDate: string
  endDate: string | null
  isInpatient: boolean
  isEmergencyAdmission: boolean
  roomCategoryCode: string | null
  ward: string | null
  primaryPayerId: number | null
  cancelled: boolean
}

export type ChargeContextRef = { encounterId: number } | { admissionId: number }

async function roomOf(executor: WriteExecutor, roomId: number | null): Promise<{ ward: string | null; roomCategoryCode: string | null }> {
  if (roomId === null) return { ward: null, roomCategoryCode: null }
  const [r] = await executor.select({ ward: rooms.ward, code: roomCategories.code }).from(rooms)
    .leftJoin(roomCategories, eq(roomCategories.id, rooms.roomCategoryId)).where(eq(rooms.id, roomId)).limit(1)
  return { ward: r?.ward ?? null, roomCategoryCode: r?.code ?? null }
}

async function primaryPayerOf(executor: WriteExecutor, patientId: string): Promise<number | null> {
  const [p] = await executor.select({ primaryPayerId: patients.primaryPayerId }).from(patients).where(eq(patients.id, patientId)).limit(1)
  return p?.primaryPayerId ?? null
}

export async function loadChargeContext(executor: WriteExecutor, ref: ChargeContextRef): Promise<ChargeContext | null> {
  if ('encounterId' in ref) {
    const [enc] = await executor.select().from(encounters).where(eq(encounters.id, ref.encounterId)).limit(1)
    if (!enc) return null
    let admission: { type: string; roomId: number | null } | null = null
    if (enc.admissionId !== null) {
      const [a] = await executor.select({ type: admissions.admissionType, roomId: admissions.currentRoomId }).from(admissions)
        .where(eq(admissions.id, enc.admissionId)).limit(1)
      admission = a ?? null
    }
    const room = await roomOf(executor, admission?.roomId ?? null)
    return {
      kind: 'encounter',
      patientId: enc.patientId,
      encounterId: enc.id,
      admissionId: enc.admissionId,
      departmentId: enc.departmentId,
      orderingProviderId: enc.providerId,
      startDate: enc.encounterDate,
      endDate: enc.completedAt ? istDateOf(enc.completedAt) : null,
      isInpatient: enc.encounterType === 'ipd',
      isEmergencyAdmission: admission?.type === 'emergency',
      roomCategoryCode: room.roomCategoryCode,
      ward: room.ward,
      primaryPayerId: await primaryPayerOf(executor, enc.patientId),
      cancelled: enc.status === 'cancelled',
    }
  }
  const [adm] = await executor.select().from(admissions).where(eq(admissions.id, ref.admissionId)).limit(1)
  if (!adm) return null
  const [prov] = await executor.select({ departmentId: providers.departmentId }).from(providers).where(eq(providers.id, adm.attendingProviderId)).limit(1)
  const [enc] = await executor.select({ id: encounters.id }).from(encounters).where(eq(encounters.admissionId, adm.id)).orderBy(asc(encounters.id)).limit(1)
  const room = await roomOf(executor, adm.currentRoomId)
  return {
    kind: 'admission',
    patientId: adm.patientId,
    encounterId: enc?.id ?? null,
    admissionId: adm.id,
    departmentId: prov?.departmentId ?? null,
    orderingProviderId: adm.attendingProviderId,
    startDate: istDateOf(adm.admittedAt),
    endDate: adm.dischargedAt ? istDateOf(adm.dischargedAt) : null,
    isInpatient: true,
    isEmergencyAdmission: adm.admissionType === 'emergency',
    roomCategoryCode: room.roomCategoryCode,
    ward: room.ward,
    primaryPayerId: await primaryPayerOf(executor, adm.patientId),
    cancelled: false,
  }
}

/** The admission's advances net of its refunds (what the deposit rule checks). */
async function admissionDepositFor(executor: WriteExecutor, patientId: string, admissionId: number): Promise<number> {
  const adv = await executor.select({ id: patientPayments.id, amount: patientPayments.amountPaise, at: patientPayments.receivedAt, number: patientPayments.receiptNumber })
    .from(patientPayments).where(and(eq(patientPayments.patientId, patientId), eq(patientPayments.admissionId, admissionId), eq(patientPayments.kind, 'advance')))
  const ref = await executor.select({ id: refunds.id, amount: refunds.amountPaise, at: refunds.issuedAt, number: refunds.refundNumber })
    .from(refunds).where(and(eq(refunds.patientId, patientId), eq(refunds.admissionId, admissionId)))
  const entries: LedgerEntry[] = [
    ...adv.map((r) => ({ kind: 'advance' as const, id: r.id, number: r.number, at: r.at, amountPaise: r.amount, admissionId })),
    ...ref.map((r) => ({ kind: 'refund' as const, id: r.id, number: r.number, at: r.at, amountPaise: r.amount, admissionId })),
  ]
  return admissionDepositPaise(entries, admissionId)
}

export interface ChargePreview {
  price: PriceResolution
  unitPricePaise: number | null
  priceSource: PriceSource | null
  taxablePaise: number | null
  estimatedTax: LineTax | null
  violations: ChargeViolation[]
  unresolved: ChargeRuleCode[]
}

export type CaptureError = 'context_not_found' | 'context_cancelled' | 'no_payer' | 'price_override_forbidden' | 'blocked'

type PricingContext = { service: ServiceForPricing | null; rates: TariffRateCandidate[] }

interface Evaluation {
  context: ChargeContext
  service: { id: number; code: string; name: string; departmentId: number; category: NonNullable<ChargeLineRow['serviceCategory']>; hsnSac: string; gstRateBp: number } | null
  price: PriceResolution
  unitPricePaise: number | null
  priceSource: PriceSource | null
  resolvedPricePaise: number | null
  tariffRateId: number | null
  taxablePaise: number | null
  estimatedTax: LineTax | null
  payerId: number | null
  procedureCodes: ProcedureCodeRef[]
  violations: ChargeViolation[]
  preauthId: number | null // SP7: the validated pre-auth (ruling 7)
}

const canOverride = (session: Session) => BILLING_AUTHORITY_ROLES.includes(session.role)

async function evaluate(
  executor: WriteExecutor, input: ChargeCaptureInput, now: Date, pricing: PricingContext,
): Promise<{ ok: true; ev: Evaluation } | { ok: false; error: Exclude<CaptureError, 'price_override_forbidden' | 'blocked'> }> {
  const context = await loadChargeContext(executor, input.context)
  if (!context) return { ok: false, error: 'context_not_found' }
  if (context.cancelled) return { ok: false, error: 'context_cancelled' }
  const billToPayer = input.billTo === 'payer'
  if (billToPayer && context.primaryPayerId === null) return { ok: false, error: 'no_payer' }
  const payerId = billToPayer ? context.primaryPayerId : null

  const [svc] = await executor.select({
    id: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name, departmentId: serviceCatalog.departmentId,
    category: serviceCatalog.category, isActive: serviceCatalog.isActive, requiresPreauth: serviceCatalog.requiresPreauth,
    maxQuantity: serviceCatalog.maxQuantity, hsnSac: serviceCatalog.hsnSac, gstRateBp: serviceCatalog.gstRateBp,
  }).from(serviceCatalog).where(eq(serviceCatalog.id, input.serviceId)).limit(1)
  const [payer] = payerId === null ? [] : await executor.select({ id: payers.id, requiresPreauth: payers.requiresPreauth, gstin: payers.gstin, stateCode: payers.stateCode })
    .from(payers).where(eq(payers.id, payerId)).limit(1)
  const settings = await getBillingSettings(executor)
  const config = await getRuleConfig(executor)
  const mapped = await loadMappedProcedureCodes(executor, input.serviceId)

  const price = resolvePrice({
    serviceId: input.serviceId,
    payerId: payerId ?? undefined,
    departmentId: context.departmentId ?? undefined,
    roomCategory: context.roomCategoryCode ?? undefined,
    ward: context.ward ?? undefined,
    onDate: input.serviceDate,
  }, pricing)

  // Consultations in the window, the admission deposit, and same-day duplicates (read on the
  // caller's executor: inside capture's transaction, after the patient lock).
  const windowStart = addDaysIso(input.serviceDate, -settings.consultationWindowDays)
  const consultations = await executor.select({ d: encounters.encounterDate }).from(encounters).where(and(
    eq(encounters.patientId, context.patientId), inArray(encounters.encounterType, ['opd', 'ipd']), ne(encounters.status, 'cancelled'),
    gte(encounters.encounterDate, windowStart), lte(encounters.encounterDate, input.serviceDate),
  ))
  const deposit = context.admissionId === null ? null : await admissionDepositFor(executor, context.patientId, context.admissionId)
  const [dup] = await executor.select({ n: sql<number>`count(*)::int` }).from(chargeLines).where(and(
    eq(chargeLines.patientId, context.patientId), eq(chargeLines.serviceId, input.serviceId), eq(chargeLines.serviceDate, input.serviceDate),
    ne(chargeLines.status, 'void'),
    context.admissionId !== null ? eq(chargeLines.admissionId, context.admissionId) : eq(chargeLines.encounterId, context.encounterId!),
  ))

  // Unit price: a manual price (authority roles only, checked by the caller) or the resolver's.
  let unitPricePaise: number | null = null
  let priceSource: PriceSource | null = null
  let resolvedPricePaise: number | null = null
  let tariffRateId: number | null = null
  if (input.manualUnitPricePaise !== undefined) {
    unitPricePaise = input.manualUnitPricePaise
    priceSource = 'manual'
    resolvedPricePaise = price.ok ? price.amountPaise : null
    tariffRateId = price.ok ? price.rateId : null
  } else if (price.ok) {
    unitPricePaise = price.amountPaise
    priceSource = price.scope
    tariffRateId = price.rateId
  }
  const taxablePaise = unitPricePaise === null ? null : lineTaxablePaise(unitPricePaise, input.quantity)

  let estimatedTax: LineTax | null = null
  if (taxablePaise !== null && svc && settings.stateCode) {
    let recipient = payer?.stateCode ?? (payer?.gstin ? stateCodeOfGstin(payer.gstin) : null)
    if (recipient === null) {
      const [p] = await executor.select({ stateCode: patients.stateCode }).from(patients).where(eq(patients.id, context.patientId)).limit(1)
      recipient = p?.stateCode ?? null
    }
    const pos = placeOfSupply({ mode: settings.placeOfSupplyMode, hospitalStateCode: settings.stateCode, recipientStateCode: recipient })
    estimatedTax = lineTax(taxablePaise, svc.gstRateBp, pos.supplyType)
  }

  const requested = input.procedureCodes ?? []
  // SP7 (ruling 7): a reference typed on a payer line is checked against the patient's pre-auths,
  // on the same executor (inside capture's transaction, after the patient lock).
  const reference = input.preAuthReference?.trim() ?? ''
  const preauth = billToPayer && reference !== ''
    ? await validatePreauthReference(executor, { patientId: context.patientId, payerId, reference, serviceDate: input.serviceDate })
    : null
  // end SP7
  const ruleInput: ChargeRuleInput = {
    service: svc ? { id: svc.id, departmentId: svc.departmentId, category: svc.category, isActive: svc.isActive, requiresPreauth: svc.requiresPreauth, maxQuantity: svc.maxQuantity } : null,
    quantity: input.quantity,
    serviceDate: input.serviceDate,
    today: todayIsoIn(DEFAULT_TIMEZONE, now),
    context: { departmentId: context.departmentId, startDate: context.startDate, endDate: context.endDate, isInpatient: context.isInpatient, isEmergencyAdmission: context.isEmergencyAdmission },
    payer: payer ? { id: payer.id, requiresPreauth: payer.requiresPreauth } : null,
    preAuthReference: input.preAuthReference ?? null,
    priceResolved: unitPricePaise !== null,
    consultationDates: consultations.map((c) => c.d),
    admissionDepositPaise: deposit,
    sameDayDuplicates: dup?.n ?? 0,
    mappedProcedureCodes: mapped,
    requestedProcedureCodes: requested,
    preAuthCheck: preauth?.status ?? null, // SP7
  }
  const violations = evaluateChargeRules(ruleInput, {
    consultationWindowDays: settings.consultationWindowDays, ipdDepositThresholdPaise: settings.ipdDepositThresholdPaise,
  }, config)

  return {
    ok: true,
    ev: {
      context,
      service: svc ? { id: svc.id, code: svc.code, name: svc.name, departmentId: svc.departmentId, category: svc.category, hsnSac: svc.hsnSac, gstRateBp: svc.gstRateBp } : null,
      price, unitPricePaise, priceSource, resolvedPricePaise, tariffRateId, taxablePaise, estimatedTax, payerId,
      // With mapped codes and none requested, the line carries the primary mapped code.
      procedureCodes: requested.length === 0 && mapped.length > 0 ? [mapped[0]] : requested,
      violations,
      preauthId: preauth?.status === 'valid' ? preauth.preauthId : null, // SP7
    },
  }
}

export async function previewChargeLine(
  input: ChargeCaptureInput, session: Session, now: Date = new Date(),
): Promise<{ ok: true; preview: ChargePreview } | { ok: false; error: CaptureError }> {
  if (input.manualUnitPricePaise !== undefined && !canOverride(session)) return { ok: false, error: 'price_override_forbidden' }
  const pricing = await loadPricingContext(input.serviceId)
  const r = await evaluate(getDb(), input, now, pricing)
  if (!r.ok) return r
  const { ev } = r
  return {
    ok: true,
    preview: {
      price: ev.price, unitPricePaise: ev.unitPricePaise, priceSource: ev.priceSource, taxablePaise: ev.taxablePaise,
      estimatedTax: ev.estimatedTax, violations: ev.violations,
      unresolved: unresolvedBlocks(ev.violations, input.overrides ?? [], canOverride(session)).map((v) => v.code),
    },
  }
}

export async function captureChargeLine(
  input: ChargeCaptureInput, session: Session, now: Date = new Date(),
): Promise<{ ok: true; line: ChargeLineRow; violations: ChargeViolation[] } | { ok: false; error: CaptureError; violations?: ChargeViolation[] }> {
  if (input.manualUnitPricePaise !== undefined && !canOverride(session)) return { ok: false, error: 'price_override_forbidden' }
  // The patient id is immutable on an encounter/admission, so it is safe to read before locking.
  const pre = await loadChargeContext(getDb(), input.context)
  if (!pre) return { ok: false, error: 'context_not_found' }
  const pricing = await loadPricingContext(input.serviceId)

  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, pre.patientId)
    const r = await evaluate(tx, input, now, pricing)
    if (!r.ok) return r
    const { ev } = r
    const authority = canOverride(session)
    const overrides = input.overrides ?? []
    const blocks = unresolvedBlocks(ev.violations, overrides, authority)
    if (blocks.length > 0 || ev.service === null || ev.unitPricePaise === null || ev.priceSource === null || ev.taxablePaise === null) {
      return { ok: false as const, error: 'blocked' as const, violations: ev.violations }
    }
    const applied = appliedOverrides(ev.violations, overrides, authority)
    const appliedCodes = new Set(applied.map((o) => o.code))
    const stored = ev.violations.filter((v) => v.severity !== 'block' || appliedCodes.has(v.code))

    const [line] = await tx.insert(chargeLines).values({
      patientId: ev.context.patientId,
      encounterId: ev.context.encounterId,
      admissionId: ev.context.admissionId,
      source: 'manual',
      serviceId: ev.service.id,
      itemCode: ev.service.code,
      itemName: ev.service.name,
      serviceCategory: ev.service.category,
      departmentId: ev.service.departmentId,
      orderingProviderId: ev.context.orderingProviderId,
      performingProviderId: input.performingProviderId ?? null,
      serviceDate: input.serviceDate,
      quantity: input.quantity,
      unitPricePaise: ev.unitPricePaise,
      priceSource: ev.priceSource,
      tariffRateId: ev.tariffRateId,
      resolvedPricePaise: ev.resolvedPricePaise,
      priceOverrideReason: ev.priceSource === 'manual' ? (input.priceOverrideReason ?? '').trim() || null : null,
      taxablePaise: ev.taxablePaise,
      gstRateBp: ev.service.gstRateBp,
      hsnSac: ev.service.hsnSac,
      payerId: ev.payerId,
      preAuthReference: input.preAuthReference ?? null,
      preauthId: ev.preauthId, // SP7
      procedureCodes: ev.procedureCodes,
      violations: stored,
      ruleOverrides: applied,
      createdByName: session.name,
      createdByUserId: session.userId,
    }).returning()

    const patientId = ev.context.patientId
    await logAudit(session, 'billing: captured charge line', patientId,
      `line=${line.id} service=${ev.service.code} qty=${line.quantity} price=${line.priceSource}`, tx)
    if (line.priceSource === 'manual') {
      await logAudit(session, 'billing: overrode charge price', patientId,
        `line=${line.id} resolved=${ev.resolvedPricePaise ?? 'none'} charged=${line.unitPricePaise}`, tx)
    }
    if (applied.length > 0) {
      await logAudit(session, 'billing: overrode charge rule', patientId, `line=${line.id} rules=${applied.map((o) => o.code).join(',')}`, tx)
    }
    return { ok: true as const, line, violations: stored }
  })
}

/** Voids a captured line (also one on a draft invoice, which it leaves). Invoiced and void lines are refused. */
export async function voidChargeLine(lineId: number, reason: string, session: Session): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_voidable' }> {
  const [pre] = await getDb().select({ patientId: chargeLines.patientId }).from(chargeLines).where(eq(chargeLines.id, lineId)).limit(1)
  if (!pre) return { ok: false, error: 'not_found' }
  return getDb().transaction(async (tx) => {
    await lockPatientBilling(tx, pre.patientId)
    const [line] = await tx.select({ status: chargeLines.status }).from(chargeLines).where(eq(chargeLines.id, lineId)).for('update')
    if (!line) return { ok: false as const, error: 'not_found' as const }
    if (line.status !== 'captured') return { ok: false as const, error: 'not_voidable' as const }
    await tx.update(chargeLines).set({ status: 'void', voidReason: reason.trim(), voidedAt: new Date(), voidedByName: session.name, invoiceId: null })
      .where(eq(chargeLines.id, lineId))
    await logAudit(session, 'billing: voided charge line', pre.patientId, `line=${lineId}`, tx)
    return { ok: true as const }
  })
}

// ---------- reads for the charge capture screen ----------

export interface CaptureEncounterRow { id: number; patientId: string; patientName: string; uhid: string | null; opdToken: number | null; departmentName: string | null; providerName: string }
export interface CaptureAdmissionRow { id: number; patientId: string; patientName: string; uhid: string | null; ward: string | null; roomNumber: string | null; admittedOn: string }

/** Today's (IST) non-cancelled OPD visits and every admitted patient, named columns only. */
export async function listCaptureContexts(todayIso: string): Promise<{ encounters: CaptureEncounterRow[]; admissions: CaptureAdmissionRow[] }> {
  const db = getDb()
  const enc = await db.select({
    id: encounters.id, patientId: encounters.patientId, patientName: patients.name, uhid: patients.uhid, opdToken: encounters.opdToken,
    departmentName: departments.name, providerName: providers.name,
  }).from(encounters).innerJoin(patients, eq(patients.id, encounters.patientId)).innerJoin(providers, eq(providers.id, encounters.providerId))
    .leftJoin(departments, eq(departments.id, encounters.departmentId))
    .where(and(eq(encounters.encounterDate, todayIso), eq(encounters.encounterType, 'opd'), ne(encounters.status, 'cancelled')))
    .orderBy(asc(encounters.opdToken), asc(encounters.id))
  const adm = await db.select({
    id: admissions.id, patientId: admissions.patientId, patientName: patients.name, uhid: patients.uhid, ward: rooms.ward, roomNumber: rooms.roomNumber, admittedAt: admissions.admittedAt,
  }).from(admissions).innerJoin(patients, eq(patients.id, admissions.patientId)).leftJoin(rooms, eq(rooms.id, admissions.currentRoomId))
    .where(eq(admissions.status, 'admitted')).orderBy(asc(admissions.admittedAt), asc(admissions.id))
  return {
    encounters: enc,
    admissions: adm.map(({ admittedAt, ...a }) => ({ ...a, admittedOn: istDateOf(admittedAt) })),
  }
}

export interface CaptureHeader {
  kind: 'encounter' | 'admission'
  patientId: string
  patientName: string
  uhid: string | null
  label: string
  primaryPayerId: number | null
  payerName: string | null
  /** Advances net of refunds for an admission; null for a visit. */
  depositPaise: number | null
}

export async function getCaptureHeader(ref: ChargeContextRef): Promise<CaptureHeader | null> {
  const db = getDb()
  const context = await loadChargeContext(db, ref)
  if (!context) return null
  const [patient] = await db.select({ name: patients.name, uhid: patients.uhid }).from(patients).where(eq(patients.id, context.patientId)).limit(1)
  const [payer] = context.primaryPayerId === null ? [] : await db.select({ name: payers.name }).from(payers).where(eq(payers.id, context.primaryPayerId)).limit(1)
  const room = context.ward
  let label: string
  if (context.kind === 'admission') {
    label = `Inpatient stay, admitted ${formatIsoDate(context.startDate)}${room ? ` · ${room}` : ''}${context.endDate ? ` · discharged ${formatIsoDate(context.endDate)}` : ''}`
  } else {
    label = `${context.isInpatient ? 'Inpatient' : 'Outpatient'} visit, ${formatIsoDate(context.startDate)}${context.cancelled ? ' (cancelled)' : ''}`
  }
  return {
    kind: context.kind,
    patientId: context.patientId,
    patientName: patient?.name ?? context.patientId,
    uhid: patient?.uhid ?? null,
    label,
    primaryPayerId: context.primaryPayerId,
    payerName: payer?.name ?? null,
    depositPaise: context.kind === 'admission' && context.admissionId !== null ? await admissionDepositFor(db, context.patientId, context.admissionId) : null,
  }
}

/** Every line of a visit or stay (void and invoiced included), oldest service date first. */
export async function listChargeLinesForContext(ref: ChargeContextRef): Promise<ChargeLineRow[]> {
  const where = 'admissionId' in ref ? eq(chargeLines.admissionId, ref.admissionId) : eq(chargeLines.encounterId, ref.encounterId)
  return getDb().select().from(chargeLines).where(where).orderBy(asc(chargeLines.serviceDate), asc(chargeLines.id))
}

// ---------- pharmacy lines with no visit or stay ----------
// A pharmacy bill for a patient who is not admitted becomes a line with neither an encounter nor an
// admission. These two reads give such lines a screen, so they can be drafted onto an invoice
// (createDraftInvoice groups them on their own) or voided.

const noContext = and(isNull(chargeLines.encounterId), isNull(chargeLines.admissionId))

export interface UnbilledPharmacyPatientRow { patientId: string; patientName: string; uhid: string | null; lineCount: number; taxablePaise: number }

/** Patients with captured, not-yet-drafted pharmacy lines that carry no visit or stay. */
export async function listUnbilledPharmacyPatients(): Promise<UnbilledPharmacyPatientRow[]> {
  const rows = await getDb().select({
    patientId: chargeLines.patientId, patientName: patients.name, uhid: patients.uhid,
    lineCount: sql<number>`count(*)::int`, taxable: sql<string>`sum(${chargeLines.taxablePaise})`,
  }).from(chargeLines).innerJoin(patients, eq(patients.id, chargeLines.patientId))
    .where(and(noContext, eq(chargeLines.status, 'captured'), isNull(chargeLines.invoiceId)))
    .groupBy(chargeLines.patientId, patients.name, patients.uhid).orderBy(asc(patients.name), asc(chargeLines.patientId))
  return rows.map(({ taxable, ...r }) => ({ ...r, taxablePaise: paiseFromDb(taxable) }))
}

/** Every no-context line of a patient (void and invoiced included); null when the patient does not exist. */
export async function getPharmacyCaptureView(patientId: string): Promise<{ patientId: string; patientName: string; uhid: string | null; lines: ChargeLineRow[] } | null> {
  const db = getDb()
  const [patient] = await db.select({ name: patients.name, uhid: patients.uhid }).from(patients).where(eq(patients.id, patientId)).limit(1)
  if (!patient) return null
  const lines = await db.select().from(chargeLines).where(and(eq(chargeLines.patientId, patientId), noContext))
    .orderBy(asc(chargeLines.serviceDate), asc(chargeLines.id))
  return { patientId, patientName: patient.name, uhid: patient.uhid, lines }
}

