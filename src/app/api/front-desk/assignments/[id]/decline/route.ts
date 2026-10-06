import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/db/client'
import { doctorAssignments } from '@/db/schema'
import { declineAssignment } from '@/lib/queries/doctor-assignments'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'

const declineSchema = z.object({ reason: z.string().min(1) }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'pi') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const assignmentId = Number(id)
  if (!Number.isInteger(assignmentId)) return NextResponse.json({ error: 'Invalid assignment id' }, { status: 400 })

  const parsed = declineSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid decline payload', details: parsed.error.flatten() }, { status: 400 })

  // Load the assignment row BEFORE mutating it, so ownership can be checked
  // and a 403 returned before declineAssignment ever touches the row --
  // same provider resolution as /doctor, the nav badge and the schedule route.
  const [assignmentRow] = await getDb().select().from(doctorAssignments).where(eq(doctorAssignments.id, assignmentId))
  if (!assignmentRow) return NextResponse.json({ error: 'Assignment not found' }, { status: 404 })

  const providerMatch = await resolveDoctorQueueProvider(session)
  if (!providerMatch || assignmentRow.providerId !== providerMatch.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const alreadyHandled = { error: 'This assignment has already been scheduled or declined.' }
  if (assignmentRow.status !== 'pending') {
    return NextResponse.json(alreadyHandled, { status: 409 })
  }

  // Null means the row stopped being pending after our read (e.g. a
  // concurrent schedule committed); a missing row already 404'd above.
  const updated = await declineAssignment(assignmentId, parsed.data.reason)
  if (!updated) return NextResponse.json(alreadyHandled, { status: 409 })

  await logAudit(session, 'declined assignment', updated.patientId)
  return NextResponse.json(updated, { status: 200 })
}
