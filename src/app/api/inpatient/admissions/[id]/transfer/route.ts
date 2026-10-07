import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getAdmissionById, transferAdmission } from '@/lib/queries/admissions'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

const transferSchema = z.object({ toRoomId: z.number().int().positive(), reason: z.string().min(1) }).strict()

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

  const result = await transferAdmission(admissionId, parsed.data.toRoomId, parsed.data.reason, session.name)
  if (!result.ok) {
    const status = result.error === 'Admission not found' ? 404 : 409
    return NextResponse.json({ error: result.error }, { status })
  }

  await logAudit(session, `transferred patient's admission ${admissionId} to room ${parsed.data.toRoomId}`, admission.patientId)
  return NextResponse.json({ ok: true })
}
