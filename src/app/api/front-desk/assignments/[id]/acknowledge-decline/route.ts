import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import { acknowledgeDecline } from '@/lib/queries/doctor-assignments'

const ALLOWED_ROLES = ['frontdesk', 'admin', 'crc']

// No body and no message to anyone (spec section 6): this only records that
// staff have seen the decline.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const assignmentId = Number(id)
  if (!Number.isInteger(assignmentId) || assignmentId <= 0) return NextResponse.json({ error: 'Invalid assignment id' }, { status: 400 })

  const [existing] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignmentId))
  if (!existing) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })
  if (existing.status !== 'declined') return NextResponse.json({ error: 'Only a declined assignment can be marked handled.' }, { status: 409 })

  const alreadyHandled = { error: 'This decline has already been marked handled.' }
  if (existing.declineAcknowledgedAt) return NextResponse.json(alreadyHandled, { status: 409 })

  const updated = await acknowledgeDecline(assignmentId, session.name)
  if (!updated) return NextResponse.json(alreadyHandled, { status: 409 })

  await logAudit(session, 'acknowledged declined assignment', updated.patientId)
  return NextResponse.json(updated, { status: 200 })
}
