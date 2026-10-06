import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAdmissionById } from '@/lib/queries/admissions'
import { administerMedication } from '@/lib/queries/medication-administrations'

const administerSchema = z.object({
  status: z.enum(['given', 'held', 'refused']),
  notes: z.string().optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; medId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id, medId } = await params
  const admissionId = Number(id)
  const medicationId = Number(medId)
  if (!Number.isInteger(admissionId) || !Number.isInteger(medicationId)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const admission = await getAdmissionById(admissionId)
  if (!admission) return NextResponse.json({ error: 'Admission not found' }, { status: 404 })

  const parsed = administerSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await administerMedication(medicationId, admissionId, { status: parsed.data.status, administeredByName: session.name, notes: parsed.data.notes ?? null })
  if (!result.ok) {
    const status = result.error?.includes('reason is required') ? 400 : 409
    return NextResponse.json({ error: result.error ?? 'Medication row is not currently scheduled, or does not exist' }, { status })
  }

  await logAudit(session, 'recorded medication administration', admission.patientId)
  return NextResponse.json({ ok: true })
}
