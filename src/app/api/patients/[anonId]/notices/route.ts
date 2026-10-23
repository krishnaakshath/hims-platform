// Foundations T9: the patient chart's "Recent notices" panel. Template, channel, status and time
// only -- never a destination, message body, provider id or error detail.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { patientExists } from '@/lib/queries/patient-exists'
import { listPatientNotices } from '@/lib/queries/notification-log'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'crc', 'pi', 'frontdesk'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  if (!(await patientExists(anonId))) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  const rows = await listPatientNotices(anonId, 10)
  await logAudit(session, 'viewed patient notices', anonId)
  return NextResponse.json({ items: rows.map((r) => ({ templateKey: r.templateKey, channel: r.channel, status: r.status, createdAt: r.createdAt.toISOString() })) })
}
