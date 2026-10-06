import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAdmissionById, dischargeAdmission } from '@/lib/queries/admissions'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { hasSchedulingConflict } from '@/lib/queries/appointments'
import { createSignature } from '@/lib/queries/signatures'

const DISCHARGE_ATTESTATION = 'I attest that this discharge summary is accurate and complete.'

const dischargeSchema = z.object({
  dischargeDiagnosis: z.string().min(1),
  dischargeDrugs: z.string().min(1),
  dischargeDevices: z.string().min(1),
  dischargeDiet: z.string().min(1),
  dischargeSummaryNotes: z.string().min(1),
  followUpStartsAt: z.string().min(1).optional(),
  followUpEndsAt: z.string().min(1).optional(),
  typedName: z.string().trim().min(1),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const admissionId = Number(id)
  if (!Number.isInteger(admissionId)) return NextResponse.json({ error: 'Invalid admission id' }, { status: 400 })

  const parsed = dischargeSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid discharge payload', details: parsed.error.flatten() }, { status: 400 })

  const admission = await getAdmissionById(admissionId)
  if (!admission) return NextResponse.json({ error: 'Admission not found' }, { status: 404 })

  // Mirrors signNote's exact posture (encounter-notes.ts): the typed name
  // must match the authenticated signer's own session name, unless the
  // signer is an admin (admin override, same as signNote). Without this,
  // `typedName` is an arbitrary free-text field with no tie to who's
  // actually signing -- the chart displays it as authoritative fact
  // ("Signed by {signerTypedName}"), so an unchecked mismatch would let a PI
  // attest a discharge under a name that isn't their own.
  if (parsed.data.typedName !== session.name && session.role !== 'admin') {
    return NextResponse.json({ error: 'The typed name must match your own name to sign this discharge' }, { status: 403 })
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
    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      return NextResponse.json({ error: 'followUpEndsAt must be a valid time after followUpStartsAt' }, { status: 400 })
    }
    if (await hasSchedulingConflict(admission.attendingProviderId, startsAt, endsAt)) {
      return NextResponse.json({ error: 'The attending provider already has an appointment during that time.' }, { status: 409 })
    }
    followUp = { startsAt, endsAt }
  }

  const result = await dischargeAdmission(admissionId, {
    dischargeDiagnosis: parsed.data.dischargeDiagnosis,
    dischargeDrugs: parsed.data.dischargeDrugs,
    dischargeDevices: parsed.data.dischargeDevices,
    dischargeDiet: parsed.data.dischargeDiet,
    dischargeSummaryNotes: parsed.data.dischargeSummaryNotes,
    followUp,
  })
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.error === 'Admission not found' ? 404 : 409 })
  }

  await logAudit(session, 'discharged patient', admission.patientId)

  // Insert the discharge signature as a SEPARATE step after the
  // authoritative discharge write above -- same sequential-not-transactional
  // posture dischargeAdmission itself already documents for its own
  // room-freeing/follow-up-appointment steps (this driver has no
  // multi-statement transactions). If this insert throws, the admission is
  // already correctly discharged -- the medically important fact -- and the
  // missing signature is left as a genuine, visible "Not yet signed" gap on
  // the chart (Task 4) rather than a silently swallowed error or a blocked
  // discharge.
  try {
    await createSignature({
      signableType: 'admission_discharge',
      signableId: admissionId,
      signerTypedName: parsed.data.typedName,
      signerRole: session.role,
      attestationText: DISCHARGE_ATTESTATION,
    })
  } catch (err) {
    console.error(`Failed to record discharge signature for admission ${admissionId}:`, err)
    // Make this queryable, not just console noise -- a missing discharge
    // signature is exactly the kind of gap this product's audit trail
    // exists to surface.
    await logAudit(session, 'discharge signature failed to record', admission.patientId)
  }

  return NextResponse.json({ ok: true, followUpAppointmentId: result.followUpAppointmentId ?? null })
}
