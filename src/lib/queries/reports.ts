import { formatIstTime, istDateOf } from '@/lib/india-time'
import { getDb } from '@/db/client'
import {
  appointments, providers, patients, formSubmissions, formTemplates,
  patientTrialScreenings, insuranceClaims, charges,
} from '@/db/schema'
import { eq, and, notInArray, desc } from 'drizzle-orm'
import {
  getOrSetCache,
  allAppointmentsReportCacheKey,
  unsignedNotesReportCacheKey,
  allEncountersReportCacheKey,
  insuranceCollectionsReportCacheKey,
} from '@/lib/cache'
import { publicPatientColumns } from '@/lib/queries/patient-columns'

/**
 * CROSS-PHASE DEPENDENCY (see docs/superpowers/plans/2026-09-18-phase4-schema-reconciliation.md):
 * this plan's original code assumed shapes for `appointments`/`charges`/`insuranceClaims`
 * that differ from what Phase 2 and Phase 3 actually shipped. Corrected here:
 * - appointments has startsAt/endsAt timestamps, not apptDate+apptTime, and no location field.
 * - charges has no providerId (free-text providerName instead) and no placeOfService/visitMode.
 * - insuranceClaims has no providerId/serviceDate -- "service date" is derived from the linked charge.
 */

// Both derive from the same IST (Asia/Kolkata) view of the instant, so the
// date and time columns always agree -- never the server's own zone.
function formatDate(d: Date): string {
  return istDateOf(new Date(d))
}
function formatTime(d: Date): string {
  return formatIstTime(d)
}

export async function listAllAppointmentsReport() {
  return getOrSetCache(allAppointmentsReportCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ appointment: appointments, patient: publicPatientColumns, provider: providers })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(providers, eq(appointments.providerId, providers.id))
      // No ORDER BY here previously meant Postgres could return rows in any
      // (and not even stable) order -- see the identical fix and rationale
      // in queries/documents.ts's listDocuments().
      .orderBy(desc(appointments.startsAt), desc(appointments.id))

    return rows.map((r) => ({
      id: r.appointment.id,
      apptDate: formatDate(r.appointment.startsAt),
      apptTime: formatTime(r.appointment.startsAt),
      status: r.appointment.status,
      patientId: r.patient.id,
      patientName: r.patient.name,
      dob: r.patient.dob,
      // `patients` now has a single `phone` column (Task 1 collapsed the
      // old phoneTebra/phoneIntakeq pair) -- there is no longer a distinct
      // home/mobile source, so both columns show the same value. The
      // homePhone/mobilePhone output shape is unchanged since
      // AllAppointmentsReportTable.tsx (out of this task's scope) still
      // renders them as two columns.
      homePhone: r.patient.phone ?? '—',
      mobilePhone: r.patient.phone ?? '—',
      providerName: r.provider?.name ?? r.patient.currentProvider ?? '—',
    }))
  })
}

// "Unsigned" means: a form submission whose status is 'completed' but whose
// patient has no patientTrialScreenings row yet -- the same "pending
// classification" concept the Home Dashboard already uses (see
// src/lib/queries/dashboard.ts's getDashboardData, Phase 1).
export async function listUnsignedNotesReport() {
  return getOrSetCache(unsignedNotesReportCacheKey(), 15, async () => {
    const screenedPatientIds = (
      await getDb().select({ patientId: patientTrialScreenings.patientId }).from(patientTrialScreenings)
    ).map((r) => r.patientId)

    const rows = await getDb()
      .select({ submission: formSubmissions, template: formTemplates, patient: publicPatientColumns })
      .from(formSubmissions)
      .innerJoin(formTemplates, eq(formSubmissions.templateId, formTemplates.id))
      .innerJoin(patients, eq(formSubmissions.patientId, patients.id))
      .where(
        and(
          eq(formSubmissions.status, 'completed'),
          screenedPatientIds.length > 0 ? notInArray(formSubmissions.patientId, screenedPatientIds) : undefined
        )
      )
      .orderBy(desc(formSubmissions.completedDate), desc(formSubmissions.id))

    return rows.map((r) => ({
      noteId: r.submission.id,
      patientId: r.patient.id,
      patientName: r.patient.name,
      // completedDate is a `timestamp` column -- a real Date on a cache miss
      // but a plain string after this function's own getOrSetCache Redis
      // round-trip on a cache hit (the same hazard already fixed once for
      // patientStatements.sentDate in Phase 3). Normalize to an ISO string
      // up front so every caller sees one consistent shape either way.
      visitDate: r.submission.completedDate ? new Date(r.submission.completedDate).toISOString() : null,
      noteType: r.template.name,
      status: 'Unsigned',
      assignedUser: r.patient.currentProvider ?? 'Unassigned',
    }))
  })
}

// A completed appointment IS an encounter for this app's data model -- no
// separate encounters table. "Payer Scenario" and "Encounter Status" are
// derived by a best-effort join against Phase 3's charges/insuranceClaims
// (matched by patientId, and by date for charges) rather than invented as
// static text, so the report demonstrates real cross-table data. Charges
// have no providerId (Phase 3 uses a free-text providerName since Phase 2's
// `providers` table didn't exist when Phase 3's schema was written), so this
// join is deliberately patientId+date only, never provider-scoped.
export async function listAllEncountersReport() {
  return getOrSetCache(allEncountersReportCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ appointment: appointments, patient: publicPatientColumns, provider: providers })
      .from(appointments)
      .innerJoin(patients, eq(appointments.patientId, patients.id))
      .leftJoin(providers, eq(appointments.providerId, providers.id))
      .where(eq(appointments.status, 'completed'))
      .orderBy(desc(appointments.startsAt), desc(appointments.id))

    const allCharges = await getDb().select().from(charges)
    const allClaims = await getDb().select().from(insuranceClaims)

    return rows.map((r) => {
      const apptDate = formatDate(r.appointment.startsAt)
      const matchingCharge = allCharges.find(
        (c) => c.patientId === r.patient.id && c.dateOfService === apptDate
      )
      const hasClaim = allClaims.some((c) => c.patientId === r.patient.id)
      const firstProcedure = matchingCharge?.procedureCodes?.[0]?.code ?? '—'

      return {
        encounterId: `ENC-${r.appointment.id}`,
        dateOfService: apptDate,
        patientId: r.patient.id,
        patientName: r.patient.name,
        renderingProvider: r.provider?.name ?? r.patient.currentProvider ?? '—',
        payerScenario: hasClaim ? 'Insurance' : 'Self-Pay',
        encounterStatus: matchingCharge ? 'Billed' : 'Completed — Not Billed',
        procedure: firstProcedure,
      }
    })
  })
}

export async function listInsuranceCollectionsReport() {
  return getOrSetCache(insuranceCollectionsReportCacheKey(), 15, async () => {
    const rows = await getDb()
      .select({ claim: insuranceClaims, patient: publicPatientColumns, charge: charges })
      .from(insuranceClaims)
      .innerJoin(patients, eq(insuranceClaims.patientId, patients.id))
      .innerJoin(charges, eq(insuranceClaims.chargeId, charges.id))
      .orderBy(desc(insuranceClaims.submittedDate), desc(insuranceClaims.id))

    return rows.map((r) => ({
      id: r.claim.id,
      patientId: r.patient.id,
      patientName: r.patient.name,
      payerName: r.claim.payerName,
      status: r.claim.status,
      billedAmountCents: r.claim.billedAmountCents,
      paidAmountCents: r.claim.paidAmountCents,
      // insuranceClaims has no serviceDate of its own -- every claim has a
      // required chargeId, so the linked charge's dateOfService IS the
      // service date for this row.
      serviceDate: r.charge.dateOfService,
      submittedDate: r.claim.submittedDate,
    }))
  })
}
