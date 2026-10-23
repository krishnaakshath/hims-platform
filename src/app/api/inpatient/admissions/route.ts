import { NextRequest, NextResponse } from 'next/server'
import { eq, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { readJsonBody } from '@/lib/http'
import { admitPatientSchema } from '@/lib/inpatient/validation'
import { admitPatient, type AdmitPatientError } from '@/lib/queries/admit-patient'
import { ADMISSION_ROLES } from '@/lib/role-policy'

// WS3 T2: the one admission path (spec 3.1). Fixed messages; never echo input.
const ERRORS: Record<AdmitPatientError, { status: number; error: string }> = {
  patient_not_found: { status: 404, error: 'Patient not found' },
  provider_not_found: { status: 404, error: 'Doctor not found' },
  room_unavailable: { status: 409, error: 'That bed is no longer available. Please choose another.' },
  already_admitted: { status: 409, error: 'This patient is already admitted. Use Transfer to move them to a different bed.' },
  open_opd_visit: { status: 409, error: 'The patient has an open OPD visit today. Choose whether to complete it or keep it open.' },
  ward_gender_conflict: { status: 422, error: 'This bed is in a ward for the other gender. Give a reason to override, or choose another bed.' },
  policy_mismatch: { status: 422, error: 'That policy does not belong to this patient.' },
  policy_inactive: { status: 422, error: 'That policy is not active today.' },
  preauth_mismatch: { status: 422, error: 'That pre-authorisation cannot be used for this admission.' },
  code_not_found: { status: 422, error: 'That diagnosis code is not in the current ICD-10 version.' },
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ADMISSION_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = admitPatientSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid admission payload', details: parsed.error.flatten() }, { status: 400 })
  const input = parsed.data

  // A doctor (pi) may admit only as the attending -- the transfer route's ownership rule.
  if (session.role === 'pi') {
    const own = await resolveDoctorQueueProvider(session)
    if (!own || own.id !== input.attendingProviderId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    // The chart id or a UHID typed directly (case-insensitive); an exact chart-id match wins.
    const rows = await getDb().select({ id: patients.id, uhid: patients.uhid }).from(patients)
      .where(or(eq(patients.id, input.patientId), sql`upper(${patients.uhid}) = upper(${input.patientId})`))
    const patient = rows.find((r) => r.id === input.patientId) ?? rows[0]
    if (!patient) return NextResponse.json({ error: ERRORS.patient_not_found.error, code: 'patient_not_found' }, { status: 404 })

    const result = await admitPatient({ ...input, patientId: patient.id }, session)
    if (!result.ok) {
      const mapped = ERRORS[result.error]
      return NextResponse.json({
        error: mapped.error, code: result.error,
        ...(result.conflict ? { conflict: result.conflict } : {}),
        ...(result.openEncounterId !== undefined ? { openEncounterId: result.openEncounterId } : {}),
      }, { status: mapped.status })
    }
    const deposit = input.depositRequiredPaise
    return NextResponse.json({
      admissionId: result.admissionId, encounterId: result.encounterId, patientId: patient.id, uhid: patient.uhid,
      roomLabel: result.roomLabel, depositRequiredPaise: deposit,
      ...(deposit > 0 ? { cashDeskHref: `/cash-desk?patientId=${encodeURIComponent(patient.id)}&amountPaise=${deposit}` } : {}),
    }, { status: 201 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[admission] failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not admit the patient' }, { status: 500 })
  }
}
