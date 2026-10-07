import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { appointmentInstantSchema, isTimeFieldError } from '@/lib/appointment-time'
import { getAdmissionById } from '@/lib/queries/admissions'
import { orderMedication, listMedicationsForAdmission, getMedicationEpisodeById } from '@/lib/queries/medication-administrations'

const orderSchema = z.object({
  medicationEpisodeId: z.number().int().optional(),
  medicationName: z.string().min(1),
  dose: z.string().min(1),
  // Explicit UTC offset required (the panel sends +05:30), like every appointment time.
  scheduledFor: appointmentInstantSchema,
}).strict()

// Read access is wider than the POST below (admin/crc/pi vs. admin/pi only)
// -- viewing the MAR is not the same privilege as ordering or charting a
// dose. It is still clinical data, so frontdesk is not admitted (RBAC
// controller ruling 7).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const admissionId = Number(id)
  if (!Number.isInteger(admissionId)) return NextResponse.json({ error: 'Invalid admission id' }, { status: 400 })

  const admission = await getAdmissionById(admissionId)
  if (!admission) return NextResponse.json({ error: 'Admission not found' }, { status: 404 })

  const medications = await listMedicationsForAdmission(admissionId)
  return NextResponse.json(medications)
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const admissionId = Number(id)
  if (!Number.isInteger(admissionId)) return NextResponse.json({ error: 'Invalid admission id' }, { status: 400 })

  const admission = await getAdmissionById(admissionId)
  if (!admission) return NextResponse.json({ error: 'Admission not found' }, { status: 404 })

  const parsed = orderSchema.safeParse(await request.json())
  if (!parsed.success && isTimeFieldError(parsed.error, ['scheduledFor'])) {
    return NextResponse.json({ error: 'Invalid scheduled time. Send it with a UTC offset (e.g. +05:30).' }, { status: 400 })
  }
  if (!parsed.success) return NextResponse.json({ error: 'Invalid medication order', details: parsed.error.flatten() }, { status: 400 })

  if (parsed.data.medicationEpisodeId !== undefined) {
    const episode = await getMedicationEpisodeById(parsed.data.medicationEpisodeId)
    if (!episode || episode.patientId !== admission.patientId) {
      return NextResponse.json({ error: 'medicationEpisodeId does not belong to this admission\'s patient' }, { status: 400 })
    }
  }

  const scheduledFor = new Date(parsed.data.scheduledFor)
  if (isNaN(scheduledFor.getTime())) return NextResponse.json({ error: 'Invalid scheduledFor' }, { status: 400 })

  const created = await orderMedication({
    admissionId,
    medicationEpisodeId: parsed.data.medicationEpisodeId ?? null,
    medicationName: parsed.data.medicationName,
    dose: parsed.data.dose,
    scheduledFor,
  })

  await logAudit(session, 'ordered medication', admission.patientId)
  return NextResponse.json(created, { status: 201 })
}
