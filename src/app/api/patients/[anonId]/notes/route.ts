import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { patientExists } from '@/lib/queries/patient-exists'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createNote } from '@/lib/queries/encounter-notes'
import { getAdmissionById } from '@/lib/queries/admissions'
import { getAppointment } from '@/lib/queries/appointments'
import { checkEncounterWriter } from '@/lib/encounters/ownership'

const noteSchema = z.object({
  noteType: z.enum(['progress', 'nursing', 'intake']),
  appointmentId: z.number().int().optional(),
  admissionId: z.number().int().optional(),
  // WS1 T5: the visit the note is written in (the workspace Notes tab); must be this patient's.
  encounterId: z.number().int().positive().max(2147483647).optional(),
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
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = noteSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid note payload', details: parsed.error.flatten() }, { status: 400 })

  if (!(await patientExists(anonId))) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

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

  // WS1 T5 (spec ruling 3): only the visit's own doctor (or an admin) links a note to it. A late note
  // on a completed visit is normal; a cancelled visit did not happen, so it takes no notes.
  if (parsed.data.encounterId !== undefined) {
    const check = await checkEncounterWriter(session, parsed.data.encounterId, { allowClosed: true })
    if (!check.ok && check.status === 404) return NextResponse.json({ error: 'encounterId does not belong to this patient' }, { status: 400 })
    if (!check.ok) return NextResponse.json(check.body, { status: check.status })
    if (check.encounter.patientId !== anonId) return NextResponse.json({ error: 'encounterId does not belong to this patient' }, { status: 400 })
    if (check.encounter.status === 'cancelled') return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
  }

  const created = await createNote({
    patientId: anonId,
    appointmentId: parsed.data.appointmentId ?? null,
    admissionId: parsed.data.admissionId ?? null,
    encounterId: parsed.data.encounterId ?? null,
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
