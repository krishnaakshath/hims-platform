import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { DISCHARGE_ROLES } from '@/lib/role-policy'
import { getAdmissionById, dischargeAdmission } from '@/lib/queries/admissions'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { createSignature } from '@/lib/queries/signatures'
import { followUpPlanFieldsSchema, offsetDateTimeSchema } from '@/lib/follow-ups/validation'
import { notifyFollowUpSafely } from '@/lib/follow-ups/notifier'
import { errorResponse, followUpServerError, readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache' // WS3 T6

const DISCHARGE_ATTESTATION = 'I attest that this discharge summary is accurate and complete.'
const MAX_INT = 2_147_483_647

// SP3: the slot times must carry an explicit UTC offset (the modal sends
// +05:30), so the instant never depends on the server's zone. `followUp` is the
// clinical plan; it is separate from the slot, and both may be sent.
const dischargeSchema = z.object({
  dischargeDiagnosis: z.string().min(1),
  dischargeDrugs: z.string().min(1),
  dischargeDevices: z.string().min(1),
  dischargeDiet: z.string().min(1),
  dischargeSummaryNotes: z.string().min(1),
  followUpStartsAt: offsetDateTimeSchema.optional(),
  followUpEndsAt: offsetDateTimeSchema.optional(),
  followUp: followUpPlanFieldsSchema.optional(),
  typedName: z.string().trim().min(1),
  // WS3 T6: the discharge ICD-10 codes; first = primary, rest secondary (spec 3.2 item 14).
  diagnosisCodeIds: z.array(z.number().int().positive().max(MAX_INT)).max(5).refine((ids) => new Set(ids).size === ids.length).optional(),
}).strict().refine((b) => (b.followUpStartsAt === undefined) === (b.followUpEndsAt === undefined))

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!DISCHARGE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  // Fixed message: a 400 never echoes the input (or its key names).
  const parsed = dischargeSchema.safeParse(json.body)
  if (!parsed.success) return errorResponse(400, 'Invalid discharge payload')

  const { id } = await params
  const admissionId = /^\d{1,10}$/.test(id) ? Number(id) : NaN
  if (!(admissionId > 0 && admissionId <= MAX_INT)) return errorResponse(400, 'Invalid admission id')

  const admission = await getAdmissionById(admissionId)
  if (!admission) return errorResponse(404, 'Admission not found')

  // Mirrors signNote's exact posture (encounter-notes.ts): the typed name
  // must match the authenticated signer's own session name, unless the
  // signer is an admin (admin override, same as signNote). Without this,
  // `typedName` is an arbitrary free-text field with no tie to who's
  // actually signing -- the chart displays it as authoritative fact
  // ("Signed by {signerTypedName}"), so an unchecked mismatch would let a PI
  // attest a discharge under a name that isn't their own.
  if (parsed.data.typedName !== session.name && session.role !== 'admin') {
    return errorResponse(403, 'The typed name must match your own name to sign this discharge')
  }

  if (session.role === 'pi') {
    const providerMatch = await resolveDoctorQueueProvider(session)
    if (!providerMatch || admission.attendingProviderId !== providerMatch.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  let followUp: { startsAt: Date; endsAt: Date } | null = null
  if (parsed.data.followUpStartsAt && parsed.data.followUpEndsAt) {
    const startsAt = new Date(parsed.data.followUpStartsAt)
    const endsAt = new Date(parsed.data.followUpEndsAt)
    if (endsAt <= startsAt) {
      return errorResponse(400, 'followUpEndsAt must be a valid time after followUpStartsAt')
    }
    followUp = { startsAt, endsAt }
  }

  const plan = parsed.data.followUp
  let result
  try {
    // One transaction: the slot's conflict check runs inside it, under the
    // per-doctor booking lock, so there is no pre-check here.
    result = await dischargeAdmission(admissionId, {
      dischargeDiagnosis: parsed.data.dischargeDiagnosis,
      dischargeDrugs: parsed.data.dischargeDrugs,
      dischargeDevices: parsed.data.dischargeDevices,
      dischargeDiet: parsed.data.dischargeDiet,
      dischargeSummaryNotes: parsed.data.dischargeSummaryNotes,
      followUp,
      followUpPlan: plan
        ? { timing: plan.timing, windowDaysBefore: plan.windowDaysBefore, windowDaysAfter: plan.windowDaysAfter, reason: plan.reason, planNotes: plan.planNotes ?? null }
        : null,
      diagnosisCodeIds: parsed.data.diagnosisCodeIds ?? [], // WS3 T6
    }, session)
  } catch (err) {
    // 40P01 / 40001 -> 409 "try again" (nothing was written); else a generic 500.
    return followUpServerError('discharge', err, 'Could not discharge this patient')
  }
  if (!result.ok) {
    switch (result.error) {
      case 'Admission not found': return errorResponse(404, 'Admission not found')
      case 'conflict': return errorResponse(409, 'The attending provider already has an appointment during that time.')
      case 'slot_in_past': return errorResponse(400, 'Pick a time later than now.')
      case 'due_date_invalid': return errorResponse(400, result.message ?? 'The follow-up date is not valid.')
      case 'provider_not_found': return errorResponse(409, 'The attending doctor is inactive, so a follow-up cannot be recorded.')
      // WS3 T5: the discharge dues gate (paise amounts only).
      case 'dues_outstanding': return NextResponse.json({ error: 'Dues are outstanding. Ask billing to clear or override them.', code: 'dues_outstanding', dues: result.dues }, { status: 409 })
      // WS3 T6: a refused discharge code (nothing was written). Fixed messages, never the code id.
      case 'code_not_found': return NextResponse.json({ error: 'A diagnosis code was not found. Pick it again from the list.', code: 'code_not_found' }, { status: 422 })
      case 'code_not_current': return NextResponse.json({ error: 'A diagnosis code is not in the current ICD-10 version.', code: 'code_not_current' }, { status: 422 })
      case 'code_not_valid_for_patient': return NextResponse.json({ error: "A diagnosis code does not fit this patient's sex or age.", code: 'code_not_valid_for_patient' }, { status: 422 })
      case 'coding_locked': return NextResponse.json({ error: 'Coding for this stay is locked. Raise a coding query instead.', code: 'coding_locked' }, { status: 409 })
      case 'no_ipd_encounter': return NextResponse.json({ error: 'This stay has no inpatient visit to record diagnoses on.', code: 'no_ipd_encounter' }, { status: 409 })
      default: return errorResponse(409, 'This admission has already been discharged')
    }
  }

  // WS3 T6: the chart's diagnosis list changed (as the workspace's diagnosis writes do).
  if (parsed.data.diagnosisCodeIds?.length) await invalidateCache(patientDetailCacheKey(admission.patientId))

  // Insert the discharge signature as a SEPARATE step after the committed
  // discharge transaction above. If this insert throws, the admission is
  // already correctly discharged -- the medically important fact -- and the
  // missing signature is left as a genuine, visible "Not yet signed" gap on
  // the chart rather than a silently swallowed error or a blocked discharge.
  try {
    await createSignature({
      signableType: 'admission_discharge',
      signableId: admissionId,
      signerTypedName: parsed.data.typedName,
      signerRole: session.role,
      attestationText: DISCHARGE_ATTESTATION,
    })
  } catch (err) {
    console.error(`Failed to record discharge signature for admission ${admissionId}:`, err instanceof Error ? err.name : 'error')
    // Make this queryable, not just console noise -- a missing discharge
    // signature is exactly the kind of gap this product's audit trail
    // exists to surface.
    await logAudit(session, 'discharge signature failed to record', admission.patientId)
  }

  // After commit; never throws. Ids and dates only.
  if (result.followUpOrderId !== undefined && result.followUpDueDate !== undefined) {
    await notifyFollowUpSafely(session, {
      kind: followUp ? 'booked' : 'planned',
      followUpOrderId: result.followUpOrderId,
      patientId: admission.patientId,
      dueDate: result.followUpDueDate,
      appointmentStartsAt: followUp ? followUp.startsAt : null,
    })
  }

  return NextResponse.json({ ok: true, followUpAppointmentId: result.followUpAppointmentId ?? null, followUpOrderId: result.followUpOrderId ?? null })
}
