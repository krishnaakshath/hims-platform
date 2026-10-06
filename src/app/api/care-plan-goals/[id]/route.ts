import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateGoalStatus } from '@/lib/queries/care-plans'

const goalStatusSchema = z.object({
  status: z.enum(['met', 'not_met', 'discontinued']),
}).strict()

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const goalId = Number(id)
  if (!Number.isInteger(goalId)) return NextResponse.json({ error: 'Invalid goal id' }, { status: 400 })

  const parsed = goalStatusSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid goal status payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await updateGoalStatus(goalId, parsed.data.status, session.name)
  if (!result.ok) {
    const status = result.error === 'Goal not found' ? 404 : 409
    return NextResponse.json({ error: result.error }, { status })
  }

  await logAudit(session, 'updated care plan goal status', result.patientId ?? null)
  return NextResponse.json({ ok: true }, { status: 200 })
}
