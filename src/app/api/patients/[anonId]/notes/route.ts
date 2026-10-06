import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createNote } from '@/lib/queries/encounter-notes'
import { getAdmissionById } from '@/lib/queries/admissions'
import { getAppointment } from '@/lib/queries/appointments'

const noteSchema = z.object({
  noteType: z.enum(['progress', 'nursing', 'intake']),
  appointmentId: z.number().int().optional(),
  admissionId: z.number().int().optional(),
  subjective: z.string().optional(),
  objective: z.string().optional(),
  assessment: z.string().optional(),
  plan: z.string().optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const parsed = noteSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid note payload', details: parsed.error.flatten() }, { status: 400 })

  if (parsed.data.appointmentId !== undefined && parsed.data.admissionId !== undefined) {
    return NextResponse.json({ error: 'A note may reference an appointment or an admission, not both' }, { status: 400 })
  }

  if (parsed.data.admissionId !== undefined) {
    const admission = await getAdmissionById(parsed.data.admissionId)
    if (!admission || admission.patientId !== anonId) {
      return NextResponse.json({ error: 'admissionId does not belong to this patient' }, { status: 400 })
    }
  }

  if (parsed.data.appointmentId !== undefined) {
    const appointment = await getAppointment(parsed.data.appointmentId)
    if (!appointment || appointment.patientId !== anonId) {
      return NextResponse.json({ error: 'appointmentId does not belong to this patient' }, { status: 400 })
    }
  }

  const created = await createNote({
    patientId: anonId,
    appointmentId: parsed.data.appointmentId ?? null,
    admissionId: parsed.data.admissionId ?? null,
    noteType: parsed.data.noteType,
    authorName: session.name,
    authorRole: session.role,
    subjective: parsed.data.subjective ?? null,
    objective: parsed.data.objective ?? null,
    assessment: parsed.data.assessment ?? null,
    plan: parsed.data.plan ?? null,
  })

  await logAudit(session, 'created encounter note', anonId)
  return NextResponse.json(created, { status: 201 })
}
