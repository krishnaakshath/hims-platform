import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAdmissionById, transferAdmission } from '@/lib/queries/admissions'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'
import { OVERRIDE_REASON_MIN } from '@/lib/inpatient/admission-rules'

// WS3 T4: `wardGenderOverrideReason` (10..300 chars) is required only when the destination bed's
// ward-gender restriction conflicts with the patient (spec 3.1 item 10); it is never audited.
const transferSchema = z.object({
  toRoomId: z.number().int().positive(),
  reason: z.string().min(1),
  wardGenderOverrideReason: z.string().trim().min(OVERRIDE_REASON_MIN).max(300).optional(),
}).strict()

const WARD_GENDER_MESSAGE = 'This bed is in a ward for the other gender. Give a reason to override, or choose another bed.'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc', 'pi'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const admissionId = parseId(id)
  if (admissionId === null) return NextResponse.json({ error: 'Invalid admission id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = transferSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid transfer payload', details: parsed.error.flatten() }, { status: 400 })

  const admission = await getAdmissionById(admissionId)
  if (!admission) return NextResponse.json({ error: 'Admission not found' }, { status: 404 })

  // A PI may only transfer their own attending patients -- same ownership
  // resolver as the Front Desk schedule/decline routes (provider FK link
  // first, then exact-surname match; unresolved or ambiguous -> 403).
  if (session.role === 'pi') {
    const providerMatch = await resolveDoctorQueueProvider(session)
    if (!providerMatch || admission.attendingProviderId !== providerMatch.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  let result: Awaited<ReturnType<typeof transferAdmission>>
  try {
    result = await transferAdmission(admissionId, parsed.data.toRoomId, parsed.data.reason, session.name, {
      wardGenderOverrideReason: parsed.data.wardGenderOverrideReason ?? null,
    })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[transfer] failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not transfer the patient' }, { status: 500 })
  }
  if (!result.ok) {
    if (result.error === 'ward_gender_conflict') {
      return NextResponse.json({ error: WARD_GENDER_MESSAGE, code: 'ward_gender_conflict', conflict: result.conflict }, { status: 422 })
    }
    const status = result.error === 'Admission not found' ? 404 : 409
    return NextResponse.json({ error: result.error }, { status })
  }

  await logAudit(session, `transferred patient's admission ${admissionId} to room ${parsed.data.toRoomId}`, admission.patientId)
  // Ids only: the override reason is stored on the transfer row, never in the audit log.
  if (result.wardGenderOverride) {
    await logAudit(session, 'ward gender override', admission.patientId, `admission=${admissionId} room=${parsed.data.toRoomId}`)
  }
  return NextResponse.json({ ok: true })
}
