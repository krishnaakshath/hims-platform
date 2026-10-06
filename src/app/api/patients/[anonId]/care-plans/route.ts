import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createCarePlan } from '@/lib/queries/care-plans'

const carePlanSchema = z.object({
  title: z.string().min(1),
  nextReviewDate: z.string().optional(),
  goals: z.array(z.object({
    description: z.string().min(1),
    targetDate: z.string().optional(),
  }).strict()).default([]),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pi', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const parsed = carePlanSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid care plan payload', details: parsed.error.flatten() }, { status: 400 })

  const { id, supersededPlanId } = await createCarePlan({
    patientId: anonId,
    title: parsed.data.title,
    authorName: session.name,
    nextReviewDate: parsed.data.nextReviewDate ?? null,
    goals: parsed.data.goals.map((g) => ({ description: g.description, targetDate: g.targetDate ?? null })),
  })

  await logAudit(session, 'created care plan', anonId)
  return NextResponse.json({ id, supersededPlanId }, { status: 201 })
}
