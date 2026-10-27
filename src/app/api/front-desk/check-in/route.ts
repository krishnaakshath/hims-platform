import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { and, eq, or, sql } from 'drizzle-orm'
import { requireSession, type Session } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import type { CoverageVerdict } from '@/lib/insurance/coverage'
import { getCoverageSummary, maybeStartEligibility, type MaybeEligibilityResult } from '@/lib/queries/coverage'
import { getDb } from '@/db/client'
import { patients, providers } from '@/db/schema'
import { checkInVisit, type CheckInVisitError } from '@/lib/queries/encounters'
import { CHECK_IN_ROLES } from '@/lib/role-policy'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { visitReasonSchema } from '@/lib/visit-reason-schema'
import { notArchived } from '@/lib/queries/patient-archive' // WS8 T13

const checkInSchema = z.object({
  patientId: z.string().min(1),
  providerId: z.number().int().positive(),
  visitType: z.enum(['inpatient', 'outpatient']),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
  // Shown to the patient in their visit confirmation -- see visitReasonSchema.
  reason: visitReasonSchema,
  // SP3: check in against a booked appointment (e.g. a follow-up).
  appointmentId: z.number().int().positive().optional(),
}).strict()

/**
 * WS12 T9 (R4, R5): after the check-in commits, the primary policy's verdict in the OPD check-in
 * context (warn or info, never block) and, when it can help, an NHCX check with context `checkin`.
 * Never fails the check-in: an error is logged by class name only and reported as no verdict.
 */
async function checkInCoverage(patientId: string, providerId: number, session: Session): Promise<{ coverage: CoverageVerdict | null; eligibility?: MaybeEligibilityResult }> {
  try {
    const summary = await getCoverageSummary(patientId, 'opd_checkin')
    if (!summary.primary) return { coverage: null }
    await logAudit(session, 'insurance: viewed coverage', patientId, 'context=opd_checkin')
    const eligibility = await maybeStartEligibility({ policyId: summary.primary.policyId, context: 'checkin', providerId }, session)
    return { coverage: summary.primary.verdict, eligibility }
  } catch (err) {
    console.error(`[check-in] coverage lookup failed (${err instanceof Error ? err.constructor.name : 'unknown'})`)
    return { coverage: null }
  }
}

const CHECK_IN_ERRORS: Record<CheckInVisitError, { status: number; error: string }> = {
  appointment_not_found: { status: 404, error: 'Appointment not found' },
  appointment_mismatch: { status: 409, error: 'That appointment is for a different patient or doctor.' },
  appointment_not_scheduled: { status: 409, error: 'That appointment is not in a bookable state.' },
  appointment_not_today: { status: 409, error: 'That appointment is not today.' },
  appointment_already_checked_in: { status: 409, error: 'This appointment has already been checked in.' },
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHECK_IN_ROLES.includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
  const parsed = checkInSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid check-in payload', details: parsed.error.flatten() }, { status: 400 })

  const { patientId: patientRef, providerId, visitType, urgency, reason, appointmentId } = parsed.data

  // WS3 T2 (spec 3.1 item 1): admission has its own form and route (POST /api/inpatient/admissions).
  if (visitType === 'inpatient') {
    return NextResponse.json({ error: 'Inpatients are admitted from the admission form.', code: 'use_admission_form' }, { status: 400 })
  }

  // Wave C: the chart id (what the PatientPicker sends) or a UHID typed
  // directly (case-insensitive); an exact chart-id match wins. WS8 T13: an archived chart cannot
  // be checked in or admitted (it is hidden from the queue) -- it reads as not found.
  const patientRows = await getDb().select({ id: patients.id }).from(patients)
    .where(and(notArchived(), or(eq(patients.id, patientRef), sql`upper(${patients.uhid}) = upper(${patientRef})`)))
  const patientRow = patientRows.find((r) => r.id === patientRef) ?? patientRows[0]
  if (!patientRow) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })
  const patientId = patientRow.id

  const [providerRow] = await getDb().select({ id: providers.id }).from(providers).where(eq(providers.id, providerId))
  if (!providerRow) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })

  // SP3: the assignment, its OPD token/lobby ticket, the encounter, a booked follow-up's
  // completion, the visit charges and the audit rows are one transaction.
  try {
    const result = await checkInVisit({
      patientId,
      providerId,
      visitType,
      urgency,
      reason,
      appointmentId: appointmentId ?? null,
    }, session)
    if (!result.ok) {
      const mapped = CHECK_IN_ERRORS[result.error]
      return NextResponse.json({ error: mapped.error }, { status: mapped.status })
    }
    // WS2 T9: the automatic visit charges (or why one was not captured) for the ticket and "Collect now".
    // WS12 T9: the primary policy's cover at check-in (never blocks) and an automatic NHCX check.
    const { coverage, eligibility } = await checkInCoverage(patientId, providerId, session)
    return NextResponse.json({
      ...result.assignment, encounterId: result.encounter.id, opdToken: result.encounter.opdToken, charges: result.charges,
      coverage, ...(eligibility ? { eligibility } : {}),
    }, { status: 201 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[check-in] failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not check in the patient' }, { status: 500 })
  }
}
