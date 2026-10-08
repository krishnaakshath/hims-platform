// Wave J (P1-20): the signed-in patient's own records for the portal -- bills, receipts,
// discharge summaries, prescriptions, insurance policies, ABHA status and appointment
// requests. Every read is scoped by the session's patient id in the WHERE clause (never
// checked after the fact), so another patient's id simply finds nothing and the caller
// answers 404. Every table is read by named columns: no whole patient row, no staff-only
// fields (user ids, card image blobs, coding internals), and nothing from Aadhaar.
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { getDb } from '@/db/client'
import { admissions, appointments, bookingRequests, invoices, medicationEpisodes, patientPayments, patientPolicies, patients, payers, providers } from '@/db/schema'
import { getInvoice, type InvoiceDetail } from './invoices'
import { getDischargeSummaryData } from './discharge-summary'
import { getLatestSignatureForSignable } from './signatures'
import type { DischargeSummaryData } from '@/lib/encounters/discharge-summary'

// ---------- bills and receipts ----------

export interface PortalInvoiceRow {
  id: number
  invoiceNumber: string
  invoiceDate: string
  documentTitle: string | null
  totalPaise: number
}

/** The patient's finalised invoices, newest first. Drafts, discarded and cancelled ones are never shown. */
export async function listPortalInvoices(patientId: string): Promise<PortalInvoiceRow[]> {
  const rows = await getDb()
    .select({ id: invoices.id, invoiceNumber: invoices.invoiceNumber, invoiceDate: invoices.invoiceDate, documentTitle: invoices.documentTitle, totalPaise: invoices.totalPaise })
    .from(invoices)
    .where(and(eq(invoices.patientId, patientId), eq(invoices.status, 'finalised')))
    .orderBy(desc(invoices.invoiceDate), desc(invoices.id))
  return rows.map((r) => ({ id: r.id, invoiceNumber: r.invoiceNumber ?? '', invoiceDate: r.invoiceDate ?? '', documentTitle: r.documentTitle, totalPaise: Number(r.totalPaise ?? 0) }))
}

/** One finalised invoice of this patient as the GST invoice document; null when it is not theirs or not finalised. */
export async function getPortalInvoice(patientId: string, invoiceId: number): Promise<InvoiceDetail | null> {
  const [own] = await getDb()
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.id, invoiceId), eq(invoices.patientId, patientId), eq(invoices.status, 'finalised')))
  if (!own) return null
  const invoice = await getInvoice(own.id)
  // Re-checked on the loaded row: a concurrent cancellation between the two reads hides it.
  return invoice && invoice.patientId === patientId && invoice.status === 'finalised' ? invoice : null
}

export interface PortalReceiptRow {
  id: number
  receiptNumber: string
  kind: 'advance' | 'receipt'
  receiptDate: string
  mode: string
  amountPaise: number
}

export async function listPortalReceipts(patientId: string): Promise<PortalReceiptRow[]> {
  const rows = await getDb()
    .select({ id: patientPayments.id, receiptNumber: patientPayments.receiptNumber, kind: patientPayments.kind, receiptDate: patientPayments.receiptDate, mode: patientPayments.mode, amountPaise: patientPayments.amountPaise })
    .from(patientPayments)
    .where(eq(patientPayments.patientId, patientId))
    .orderBy(desc(patientPayments.receiptDate), desc(patientPayments.id))
  return rows.map((r) => ({ ...r, amountPaise: Number(r.amountPaise) }))
}

export interface PortalReceipt extends PortalReceiptRow {
  patientName: string
  uhid: string | null
  admissionId: number | null
  reference: string | null
  receivedByName: string
  receivedAt: Date
}

/** One receipt of this patient; null when it is not theirs. */
export async function getPortalReceipt(patientId: string, receiptId: number): Promise<PortalReceipt | null> {
  const [row] = await getDb()
    .select({
      id: patientPayments.id, receiptNumber: patientPayments.receiptNumber, kind: patientPayments.kind, receiptDate: patientPayments.receiptDate,
      mode: patientPayments.mode, amountPaise: patientPayments.amountPaise, admissionId: patientPayments.admissionId, reference: patientPayments.reference,
      receivedByName: patientPayments.receivedByName, receivedAt: patientPayments.receivedAt, patientName: patients.name, uhid: patients.uhid,
    })
    .from(patientPayments)
    .innerJoin(patients, eq(patients.id, patientPayments.patientId))
    .where(and(eq(patientPayments.id, receiptId), eq(patientPayments.patientId, patientId)))
  return row ? { ...row, amountPaise: Number(row.amountPaise) } : null
}

// ---------- discharge summaries ----------

export interface PortalDischargeRow {
  admissionId: number
  admittedAt: Date
  dischargedAt: Date
  doctorName: string
  /** Only a summary the consultant has signed is shown to the patient. */
  signed: boolean
}

export async function listPortalDischarges(patientId: string): Promise<PortalDischargeRow[]> {
  const rows = await getDb()
    .select({ admissionId: admissions.id, admittedAt: admissions.admittedAt, dischargedAt: admissions.dischargedAt, doctorName: providers.name })
    .from(admissions)
    .innerJoin(providers, eq(providers.id, admissions.attendingProviderId))
    .where(and(eq(admissions.patientId, patientId), eq(admissions.status, 'discharged'), isNotNull(admissions.dischargedAt)))
    .orderBy(desc(admissions.dischargedAt), desc(admissions.id))
  const out: PortalDischargeRow[] = []
  for (const r of rows) {
    const signature = await getLatestSignatureForSignable('admission_discharge', r.admissionId)
    out.push({ admissionId: r.admissionId, admittedAt: r.admittedAt, dischargedAt: r.dischargedAt!, doctorName: r.doctorName, signed: signature !== null })
  }
  return out
}

/** The patient copy of a signed discharge summary of their own admission; null otherwise. */
export async function getPortalDischargeSummary(patientId: string, admissionId: number, now: Date = new Date()): Promise<DischargeSummaryData | null> {
  const [own] = await getDb()
    .select({ id: admissions.id })
    .from(admissions)
    .where(and(eq(admissions.id, admissionId), eq(admissions.patientId, patientId), eq(admissions.status, 'discharged')))
  if (!own) return null
  const data = await getDischargeSummaryData(own.id, { now, patientCopy: true })
  if (!data || data.patient.id !== patientId || data.signature === null) return null
  return data
}

// ---------- prescriptions ----------

export interface PortalPrescription {
  id: number
  name: string
  dose: string | null
  frequencyPerDay: number | null
  durationDays: number | null
  instructions: string | null
  startDate: string
  stopDate: string | null
  status: 'active' | 'inactive'
  prescribedAt: Date
  prescriberName: string | null
}

/** Prescriptions written in-app (prescribedAt set), newest first. Imported medication history stays on the Medications page. */
export async function listPortalPrescriptions(patientId: string): Promise<PortalPrescription[]> {
  const rows = await getDb()
    .select({
      id: medicationEpisodes.id, name: medicationEpisodes.name, dose: medicationEpisodes.dose, frequencyPerDay: medicationEpisodes.frequencyPerDay,
      durationDays: medicationEpisodes.durationDays, instructions: medicationEpisodes.instructions, startDate: medicationEpisodes.startDate,
      stopDate: medicationEpisodes.stopDate, status: medicationEpisodes.status, prescribedAt: medicationEpisodes.prescribedAt, prescriberName: providers.name,
    })
    .from(medicationEpisodes)
    .leftJoin(providers, eq(providers.id, medicationEpisodes.prescribedByProviderId))
    .where(and(eq(medicationEpisodes.patientId, patientId), isNotNull(medicationEpisodes.prescribedAt)))
    .orderBy(desc(medicationEpisodes.prescribedAt), desc(medicationEpisodes.id))
  return rows.map((r) => ({ ...r, prescribedAt: r.prescribedAt! }))
}

// ---------- insurance and ABHA ----------

export interface PortalPolicy {
  id: number
  insurerName: string
  tpaName: string | null
  policyNumber: string
  memberId: string
  planName: string | null
  policyType: string
  corporateName: string | null
  holderName: string
  relationship: string
  validFrom: string
  validTo: string
  sumInsuredPaise: number | null
  priority: 'primary' | 'secondary'
  status: 'active' | 'inactive'
}

/** Read-only: the patient's insurance policies (SP7), active first. No card images, no staff names. */
export async function listPortalPolicies(patientId: string): Promise<PortalPolicy[]> {
  const tpa = alias(payers, 'tpa')
  const rows = await getDb()
    .select({
      id: patientPolicies.id, insurerName: payers.name, tpaName: tpa.name, policyNumber: patientPolicies.policyNumber, memberId: patientPolicies.memberId,
      planName: patientPolicies.planName, policyType: patientPolicies.policyType, corporateName: patientPolicies.corporateName, holderName: patientPolicies.holderName,
      relationship: patientPolicies.relationship, validFrom: patientPolicies.validFrom, validTo: patientPolicies.validTo, sumInsuredPaise: patientPolicies.sumInsuredPaise,
      priority: patientPolicies.priority, status: patientPolicies.status,
    })
    .from(patientPolicies)
    .innerJoin(payers, eq(payers.id, patientPolicies.insurerPayerId))
    .leftJoin(tpa, eq(tpa.id, patientPolicies.tpaPayerId))
    .where(eq(patientPolicies.patientId, patientId))
    .orderBy(asc(patientPolicies.status), asc(patientPolicies.priority), desc(patientPolicies.validTo), asc(patientPolicies.id))
  return rows.map((r) => ({ ...r, sumInsuredPaise: r.sumInsuredPaise === null ? null : Number(r.sumInsuredPaise) }))
}

export interface PortalAbhaStatus {
  abhaNumberMasked: string | null
  abhaAddress: string | null
  unavailableReason: 'not_created' | 'patient_declined' | 'emergency' | 'other' | null
}

/** Read-only ABHA status from the patient master (does not depend on any ABDM integration tables). */
export async function getPortalAbhaStatus(patientId: string): Promise<PortalAbhaStatus | null> {
  const [row] = await getDb()
    .select({ abhaNumber: patients.abhaNumber, abhaAddress: patients.abhaAddress, unavailableReason: patients.abhaUnavailableReason })
    .from(patients)
    .where(eq(patients.id, patientId))
  if (!row) return null
  return {
    abhaNumberMasked: row.abhaNumber && /^\d{14}$/.test(row.abhaNumber) ? `XX-XXXX-XXXX-${row.abhaNumber.slice(-4)}` : null,
    abhaAddress: row.abhaAddress,
    unavailableReason: row.unavailableReason,
  }
}

// ---------- appointment requests ----------

export type PortalRequestKind = 'new' | 'reschedule' | 'cancel'

export interface PortalAppointmentRequest {
  id: number
  kind: PortalRequestKind
  status: 'pending' | 'confirmed' | 'declined'
  appointmentId: number | null
  preferredDateRangeStart: string
  preferredDateRangeEnd: string
  submittedAt: Date
}

/** The patient's own portal requests, newest first (the last 20). Staff decline notes are not shown. */
export async function listPortalAppointmentRequests(patientId: string): Promise<PortalAppointmentRequest[]> {
  return getDb()
    .select({
      id: bookingRequests.id, kind: bookingRequests.requestKind, status: bookingRequests.status, appointmentId: bookingRequests.appointmentId,
      preferredDateRangeStart: bookingRequests.preferredDateRangeStart, preferredDateRangeEnd: bookingRequests.preferredDateRangeEnd, submittedAt: bookingRequests.submittedAt,
    })
    .from(bookingRequests)
    .where(eq(bookingRequests.patientId, patientId))
    .orderBy(desc(bookingRequests.submittedAt), desc(bookingRequests.id))
    .limit(20)
}

/** A future, still-scheduled appointment of this patient (the only kind a patient may ask to move or cancel). */
export async function getPortalChangeableAppointment(patientId: string, appointmentId: number, now: Date = new Date()) {
  const [row] = await getDb()
    .select({ id: appointments.id, startsAt: appointments.startsAt, providerId: appointments.providerId, visitReason: appointments.visitReason })
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.patientId, patientId), eq(appointments.status, 'scheduled'), sql`${appointments.startsAt} > ${now}`))
  return row ?? null
}

/** Ids of this patient's appointments that already have a pending change request. */
export async function pendingRequestAppointmentIds(patientId: string, appointmentIds: number[]): Promise<Set<number>> {
  if (appointmentIds.length === 0) return new Set()
  const rows = await getDb()
    .select({ appointmentId: bookingRequests.appointmentId })
    .from(bookingRequests)
    .where(and(eq(bookingRequests.patientId, patientId), eq(bookingRequests.status, 'pending'), inArray(bookingRequests.appointmentId, appointmentIds)))
  return new Set(rows.map((r) => r.appointmentId!))
}

/** Active doctors a patient may name as a preference: id, name and specialty only. */
export async function listPortalBookableProviders(): Promise<{ id: number; name: string; specialty: string }[]> {
  return getDb()
    .select({ id: providers.id, name: providers.name, specialty: providers.specialty })
    .from(providers)
    .where(eq(providers.isActive, true))
    .orderBy(asc(providers.name))
}
