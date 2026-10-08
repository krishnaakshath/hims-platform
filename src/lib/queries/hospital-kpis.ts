// Wave E: live hospital KPIs for the role dashboards and nav badges.
//
// Every `load*` reads the database directly and returns only numbers,
// strings and nulls (dates as ISO strings), so a Redis hit is identical to a
// miss. Dashboards read them through the `get*` wrappers, which cache via
// getOrSetCache for a few seconds (keys carry the IST date and, where
// relevant, the provider). Nothing here selects a phone, address, Aadhaar or
// ABHA: lists carry name + UHID only, the minimum to recognise a patient.
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import {
  admissions, chargeLines, charges, encounterNotes, encounters, invoices, labOrders, labResults, labTests, medicationDispenses,
  medicationInventory, patientPayments, patients, refunds, rooms,
} from '@/db/schema'
import { getOrSetCache } from '@/lib/cache'
import { startOfIstDay, todayIsoIn } from '@/lib/india-time'
import { listFollowUpWorklist } from '@/lib/queries/follow-up-recall'
import { countWorklistBuckets, type WorklistBucket } from '@/lib/follow-ups/worklist'
import { getRcmDashboard } from '@/lib/queries/rcm-worklist'
import { countPendingBookingRequests } from '@/lib/queries/booking-requests'
import { snapshotScope, type HospitalSnapshot } from '@/lib/dashboard-tiles'
import type { Role } from '@/lib/auth'

const KPI_TTL_SECONDS = 20
const DAY_MS = 24 * 60 * 60 * 1000
const n = (v: unknown): number => Number(v ?? 0)

function istDay(dateIso: string): { start: Date; end: Date } {
  const start = startOfIstDay(dateIso)
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

// ---------- OPD ----------

export interface OpdTodayKpi { date: string; tokens: number; waiting: number; inConsultation: number; completed: number; cancelled: number }

/** OPD tokens issued on an IST day, by encounter status (optionally one doctor's). */
export async function loadOpdToday(today: string, providerId: number | null = null): Promise<OpdTodayKpi> {
  const rows = await getDb()
    .select({ status: encounters.status, n: count() })
    .from(encounters)
    .where(and(eq(encounters.encounterType, 'opd'), eq(encounters.encounterDate, today), providerId === null ? undefined : eq(encounters.providerId, providerId)))
    .groupBy(encounters.status)
  const by = Object.fromEntries(rows.map((r) => [r.status, n(r.n)])) as Partial<Record<string, number>>
  const waiting = by.checked_in ?? 0
  const inConsultation = by.in_consultation ?? 0
  const completed = by.completed ?? 0
  const cancelled = by.cancelled ?? 0
  return { date: today, tokens: waiting + inConsultation + completed + cancelled, waiting, inConsultation, completed, cancelled }
}

// ---------- IPD ----------

export interface WardCensus { ward: string; beds: number; occupied: number; available: number; dirty: number; blocked: number; occupancyPct: number | null }
export interface IpdCensusKpi { admitted: number; beds: number; occupied: number; available: number; dirty: number; blocked: number; occupancyPct: number | null; wards: WardCensus[] }

/** Occupied beds as a share of usable (non-blocked) beds, rounded; null when there are none. */
export function occupancyPct(occupied: number, beds: number, blocked: number): number | null {
  const usable = beds - blocked
  return usable > 0 ? Math.round((occupied / usable) * 100) : null
}

/** Patients currently admitted, and bed status by ward. */
export async function loadIpdCensus(): Promise<IpdCensusKpi> {
  const db = getDb()
  const [[adm], bedRows] = await Promise.all([
    db.select({ n: count() }).from(admissions).where(eq(admissions.status, 'admitted')),
    db.select({ ward: rooms.ward, status: rooms.status, n: count() }).from(rooms).groupBy(rooms.ward, rooms.status).orderBy(asc(rooms.ward)),
  ])
  const wards = new Map<string, WardCensus>()
  for (const r of bedRows) {
    const w = wards.get(r.ward) ?? { ward: r.ward, beds: 0, occupied: 0, available: 0, dirty: 0, blocked: 0, occupancyPct: null }
    w.beds += n(r.n)
    w[r.status] += n(r.n)
    wards.set(r.ward, w)
  }
  const list = [...wards.values()].map((w) => ({ ...w, occupancyPct: occupancyPct(w.occupied, w.beds, w.blocked) }))
  const sum = (k: 'beds' | 'occupied' | 'available' | 'dirty' | 'blocked') => list.reduce((s, w) => s + w[k], 0)
  return {
    admitted: n(adm?.n),
    beds: sum('beds'), occupied: sum('occupied'), available: sum('available'), dirty: sum('dirty'), blocked: sum('blocked'),
    occupancyPct: occupancyPct(sum('occupied'), sum('beds'), sum('blocked')),
    wards: list,
  }
}

// ---------- Money ----------

export interface CollectionsTodayKpi { date: string; receiptCount: number; collectedPaise: number; refundedPaise: number; netPaise: number }

/** Cash-desk takings on an IST day (receipts + advances, by receipt date), less refunds issued that day. */
export async function loadCollectionsToday(today: string): Promise<CollectionsTodayKpi> {
  const db = getDb()
  const [[p], [r]] = await Promise.all([
    db.select({ n: count(), paise: sql<string | null>`sum(${patientPayments.amountPaise})` }).from(patientPayments).where(eq(patientPayments.receiptDate, today)),
    db.select({ paise: sql<string | null>`sum(${refunds.amountPaise})` }).from(refunds).where(eq(refunds.refundDate, today)),
  ])
  const collectedPaise = n(p?.paise)
  const refundedPaise = n(r?.paise)
  return { date: today, receiptCount: n(p?.n), collectedPaise, refundedPaise, netPaise: collectedPaise - refundedPaise }
}

export interface BillingQueueKpi { draftInvoices: number; uninvoicedLines: number; uninvoicedPaise: number; pharmacyDraftCharges: number; pendingApprovalCharges: number }

/** Work waiting for billing: SP4 draft invoices, captured charge lines on no invoice yet (taxable value), and pharmacy bills (legacy charges from a dispense) still in draft. */
export async function loadBillingQueue(): Promise<BillingQueueKpi> {
  const db = getDb()
  const [[d], [l], [ph], [pa]] = await Promise.all([
    db.select({ n: count() }).from(invoices).where(eq(invoices.status, 'draft')),
    db.select({ n: count(), paise: sql<string | null>`sum(${chargeLines.taxablePaise})` }).from(chargeLines).where(and(eq(chargeLines.status, 'captured'), isNull(chargeLines.invoiceId))),
    db.select({ n: count() }).from(charges).innerJoin(medicationDispenses, eq(medicationDispenses.chargeId, charges.id)).where(eq(charges.status, 'draft')),
    db.select({ n: count() }).from(charges).where(eq(charges.status, 'pending_approval')),
  ])
  return { draftInvoices: n(d?.n), uninvoicedLines: n(l?.n), uninvoicedPaise: n(l?.paise), pharmacyDraftCharges: n(ph?.n), pendingApprovalCharges: n(pa?.n) }
}

// ---------- Labs ----------

export interface LabKpi {
  awaitingCollection: number
  inTransit: number
  atBench: number
  toVerify: number
  toReport: number
  criticalUnverified: number
  resultedToday: number
  criticalToday: number
  /** Median minutes from sample collection to result entry, for results entered on the day. */
  medianTatMinutes: number | null
}

/** Lab bench stages (same buckets as the worklist sections) and the day's result/TAT figures. */
export async function loadLabKpis(today: string): Promise<LabKpi> {
  const db = getDb()
  const { start, end } = istDay(today)
  const [stageRows, [crit], [day]] = await Promise.all([
    db.select({ status: labOrders.status, n: count() }).from(labOrders).groupBy(labOrders.status),
    db.select({ n: count() }).from(labOrders).innerJoin(labResults, eq(labResults.labOrderId, labOrders.id))
      .where(and(eq(labOrders.status, 'resulted'), eq(labResults.flag, 'critical'))),
    db.select({
      n: count(),
      critical: sql<string>`count(*) filter (where ${labResults.flag} = 'critical')`,
      median: sql<string | null>`percentile_cont(0.5) within group (order by extract(epoch from (${labResults.resultedAt} - ${labOrders.collectedAt})) / 60) filter (where ${labOrders.collectedAt} is not null)`,
    }).from(labResults).innerJoin(labOrders, eq(labOrders.id, labResults.labOrderId))
      .where(and(gte(labResults.resultedAt, start), lt(labResults.resultedAt, end))),
  ])
  const by = Object.fromEntries(stageRows.map((r) => [r.status, n(r.n)])) as Partial<Record<string, number>>
  return {
    awaitingCollection: (by.ordered ?? 0) + (by.scheduled ?? 0),
    inTransit: by.collected ?? 0,
    atBench: by.received ?? 0,
    toVerify: by.resulted ?? 0,
    toReport: by.verified ?? 0,
    criticalUnverified: n(crit?.n),
    resultedToday: n(day?.n),
    criticalToday: n(day?.critical),
    medianTatMinutes: day?.median === null || day?.median === undefined ? null : Math.round(Number(day.median)),
  }
}

/** Results on one doctor's own orders waiting for verification (the doctor home's "Results to verify"). */
export async function countResultsToVerifyForProvider(providerId: number): Promise<number> {
  const [r] = await getDb().select({ n: count() }).from(labOrders).where(and(eq(labOrders.orderedByProviderId, providerId), eq(labOrders.status, 'resulted')))
  return n(r?.n)
}

// ---------- Pharmacy ----------

export interface PharmacyKpi { outOfStock: number; lowStock: number; dispensedToday: number; unbilledDispenses: number }

/** Stock alerts (same rule as the pharmacy stock table: 0 = out, at or below reorder = low) and the day's dispensing. */
export async function loadPharmacyKpis(today: string): Promise<PharmacyKpi> {
  const db = getDb()
  const { start, end } = istDay(today)
  const [[stock], [disp], [unbilled]] = await Promise.all([
    db.select({
      out: sql<string>`count(*) filter (where ${medicationInventory.quantityOnHand} = 0)`,
      low: sql<string>`count(*) filter (where ${medicationInventory.quantityOnHand} > 0 and ${medicationInventory.quantityOnHand} <= ${medicationInventory.reorderThreshold})`,
    }).from(medicationInventory),
    db.select({ n: count() }).from(medicationDispenses).where(and(gte(medicationDispenses.dispensedAt, start), lt(medicationDispenses.dispensedAt, end))),
    db.select({ n: count() }).from(medicationDispenses).where(isNull(medicationDispenses.chargeId)),
  ])
  return { outOfStock: n(stock?.out), lowStock: n(stock?.low), dispensedToday: n(disp?.n), unbilledDispenses: n(unbilled?.n) }
}

// ---------- Follow-ups ----------

export type FollowUpBucketsKpi = Record<WorklistBucket, number> & { capped: boolean }

/** Recall worklist bucket counts -- the same rows and buckets /front-desk/follow-ups shows. */
export async function loadFollowUpBuckets(today: string, providerId: number | null = null): Promise<FollowUpBucketsKpi> {
  const res = await listFollowUpWorklist(today, { providerId })
  return { ...countWorklistBuckets(res.rows), capped: res.capped || res.missedCapped }
}

// ---------- Doctor ----------

export interface DoctorEncounterRow { encounterId: number; patientId: string; patientName: string; uhid: string | null; opdToken: number | null; status: string }
export interface DoctorInpatientRow { admissionId: number; patientId: string; patientName: string; uhid: string | null; ward: string | null; bed: string | null; admittedAt: string }
export interface DoctorLabRow { orderId: number; patientId: string; patientName: string; uhid: string | null; testName: string; flag: 'normal' | 'abnormal' | 'critical'; resultedAt: string }
export interface DoctorFollowUpRow { id: number; patientId: string; patientName: string; uhid: string | null; bucket: 'due' | 'overdue'; dueDate: string; reason: string }
export interface DoctorNoteRow { noteId: number; patientId: string; patientName: string; uhid: string | null; createdAt: string }
export interface DoctorWorkload {
  encountersToday: DoctorEncounterRow[]
  inpatients: DoctorInpatientRow[]
  resultsToVerify: DoctorLabRow[]
  labsAwaitingResult: number
  followUps: DoctorFollowUpRow[]
  unsignedNotes: number
  draftNotes: DoctorNoteRow[]
}

const FLAG_ORDER = { critical: 0, abnormal: 1, normal: 2 } as const
const DOCTOR_LIST_LIMIT = 50

/**
 * One doctor's own work: today's OPD (open tokens), current inpatients, results
 * on orders they placed that wait for verification (critical first), lab orders
 * still before a result, due/overdue follow-ups they prescribed, and their
 * draft notes. Matched by provider id; notes carry only the author's name.
 */
export async function loadDoctorWorkload({ providerId, authorName, today }: { providerId: number; authorName: string; today: string }): Promise<DoctorWorkload> {
  const db = getDb()
  const noteScope = and(eq(encounterNotes.authorName, authorName), eq(encounterNotes.status, 'draft'))
  const [encRows, inRows, labRows, [pending], [notes], noteRows, fu] = await Promise.all([
    db.select({ encounterId: encounters.id, patientId: encounters.patientId, patientName: patients.name, uhid: patients.uhid, opdToken: encounters.opdToken, status: encounters.status })
      .from(encounters).innerJoin(patients, eq(patients.id, encounters.patientId))
      .where(and(eq(encounters.providerId, providerId), eq(encounters.encounterType, 'opd'), eq(encounters.encounterDate, today), inArray(encounters.status, ['checked_in', 'in_consultation'])))
      .orderBy(asc(encounters.opdToken), asc(encounters.id)).limit(DOCTOR_LIST_LIMIT),
    db.select({ admissionId: admissions.id, patientId: admissions.patientId, patientName: patients.name, uhid: patients.uhid, ward: rooms.ward, roomNumber: rooms.roomNumber, bedNumber: rooms.bedNumber, admittedAt: admissions.admittedAt })
      .from(admissions).innerJoin(patients, eq(patients.id, admissions.patientId)).leftJoin(rooms, eq(rooms.id, admissions.currentRoomId))
      .where(and(eq(admissions.attendingProviderId, providerId), eq(admissions.status, 'admitted')))
      .orderBy(asc(admissions.admittedAt)).limit(DOCTOR_LIST_LIMIT),
    db.select({ orderId: labOrders.id, patientId: labOrders.patientId, patientName: patients.name, uhid: patients.uhid, testName: labTests.name, flag: labResults.flag, resultedAt: labResults.resultedAt })
      .from(labOrders).innerJoin(labResults, eq(labResults.labOrderId, labOrders.id)).innerJoin(labTests, eq(labTests.id, labOrders.labTestId)).innerJoin(patients, eq(patients.id, labOrders.patientId))
      .where(and(eq(labOrders.orderedByProviderId, providerId), eq(labOrders.status, 'resulted')))
      .orderBy(desc(labResults.resultedAt)).limit(DOCTOR_LIST_LIMIT),
    db.select({ n: count() }).from(labOrders).where(and(eq(labOrders.orderedByProviderId, providerId), inArray(labOrders.status, ['ordered', 'scheduled', 'collected', 'received']))),
    db.select({ n: count() }).from(encounterNotes).where(noteScope),
    db.select({ noteId: encounterNotes.id, patientId: encounterNotes.patientId, patientName: patients.name, uhid: patients.uhid, createdAt: encounterNotes.createdAt })
      .from(encounterNotes).innerJoin(patients, eq(patients.id, encounterNotes.patientId))
      .where(noteScope).orderBy(asc(encounterNotes.createdAt)).limit(DOCTOR_LIST_LIMIT),
    listFollowUpWorklist(today, { providerId }),
  ])
  const followUps = fu.rows
    .filter((r): r is typeof r & { bucket: 'due' | 'overdue' } => r.bucket === 'due' || r.bucket === 'overdue')
    .sort((a, b) => (a.bucket === b.bucket ? (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.id - b.id) : a.bucket === 'overdue' ? -1 : 1))
    .slice(0, DOCTOR_LIST_LIMIT)
    .map((r) => ({ id: r.id, patientId: r.patientId, patientName: r.patientName, uhid: r.uhid, bucket: r.bucket, dueDate: r.dueDate, reason: r.reason }))
  return {
    encountersToday: encRows.map((r) => ({ ...r, status: String(r.status) })),
    inpatients: inRows.map((r) => ({
      admissionId: r.admissionId, patientId: r.patientId, patientName: r.patientName, uhid: r.uhid, ward: r.ward,
      bed: r.roomNumber !== null && r.bedNumber !== null ? `${r.roomNumber}-${r.bedNumber}` : null, admittedAt: r.admittedAt.toISOString(),
    })),
    resultsToVerify: labRows
      .map((r) => ({ ...r, resultedAt: r.resultedAt.toISOString() }))
      .sort((a, b) => FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag]),
    labsAwaitingResult: n(pending?.n),
    followUps,
    unsignedNotes: n(notes?.n),
    draftNotes: noteRows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  }
}

// ---------- Patient labels ----------

/** Name and UHID for a set of patient ids (dashboard lists): never phone, address or identity numbers. */
export async function listPatientLabels(ids: string[]): Promise<{ id: string; name: string; uhid: string | null }[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  return getDb().select({ id: patients.id, name: patients.name, uhid: patients.uhid }).from(patients).where(inArray(patients.id, unique))
}

// ---------- Claims (admin view of the RCM desk) ----------

export interface ClaimAgeingKpi { outstandingPaise: number; aging: { label: string; paise: number }[]; preauthsOverdue: number; queried: number }

export async function loadClaimAgeing(): Promise<ClaimAgeingKpi> {
  const d = await getRcmDashboard()
  return { outstandingPaise: d.insurerOutstandingPaise, aging: d.aging, preauthsOverdue: d.counts.preauthsOverdue, queried: d.counts.queried }
}

// ---------- Cached wrappers (dashboards) ----------

export function hospitalKpiCacheKey(name: string, ...parts: (string | number)[]): string {
  return ['kpi', name, ...parts].join(':')
}

export const getOpdToday = (providerId: number | null = null, today = todayIsoIn()) =>
  getOrSetCache(hospitalKpiCacheKey('opd', today, providerId ?? 'all'), KPI_TTL_SECONDS, () => loadOpdToday(today, providerId))
export const getIpdCensus = () => getOrSetCache(hospitalKpiCacheKey('ipd'), KPI_TTL_SECONDS, () => loadIpdCensus())
export const getCollectionsToday = (today = todayIsoIn()) =>
  getOrSetCache(hospitalKpiCacheKey('collections', today), KPI_TTL_SECONDS, () => loadCollectionsToday(today))
export const getBillingQueue = () => getOrSetCache(hospitalKpiCacheKey('billing-queue'), KPI_TTL_SECONDS, () => loadBillingQueue())
export const getLabKpis = (today = todayIsoIn()) => getOrSetCache(hospitalKpiCacheKey('labs', today), KPI_TTL_SECONDS, () => loadLabKpis(today))
export const getPharmacyKpis = (today = todayIsoIn()) =>
  getOrSetCache(hospitalKpiCacheKey('pharmacy', today), KPI_TTL_SECONDS, () => loadPharmacyKpis(today))
export const getFollowUpBuckets = (providerId: number | null = null, today = todayIsoIn()) =>
  getOrSetCache(hospitalKpiCacheKey('follow-ups', today, providerId ?? 'all'), KPI_TTL_SECONDS, () => loadFollowUpBuckets(today, providerId))
export const getClaimAgeing = () => getOrSetCache(hospitalKpiCacheKey('claims'), 60, () => loadClaimAgeing())
export const getDoctorWorkload = (providerId: number, authorName: string, today = todayIsoIn()) =>
  getOrSetCache(hospitalKpiCacheKey('doctor', today, providerId, encodeURIComponent(authorName)), KPI_TTL_SECONDS, () => loadDoctorWorkload({ providerId, authorName, today }))

/** The hospital overview for one role: only the sections that role may open (dashboard-tiles.ts). */
export async function getHospitalSnapshot(role: Role): Promise<HospitalSnapshot> {
  const scope = snapshotScope(role)
  const [opd, ipd, followUps, labs, collections, billing, claims, bookingRequestsPending] = await Promise.all([
    getOpdToday(),
    getIpdCensus(),
    scope.followUps ? getFollowUpBuckets() : null,
    scope.labs ? getLabKpis() : null,
    scope.collections ? getCollectionsToday() : null,
    scope.billing ? getBillingQueue() : null,
    scope.claims ? getClaimAgeing() : null,
    scope.bookingRequests ? countPendingBookingRequests() : null,
  ])
  return { opd, ipd, followUps, labs, collections, billing, claims, bookingRequestsPending }
}
