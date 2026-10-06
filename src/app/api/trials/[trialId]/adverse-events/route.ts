import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAdverseEvents, createAdverseEvent, markAdverseEventNotified } from '@/lib/queries/trial-compliance'

// Same roles as /trials/[trialId] itself (LeftNav: crc, pi, admin) -- AE
// reporting is CRC/PI regulatory record-keeping, not a pharmacy/front-desk
// concern.
const ALLOWED_ROLES = ['crc', 'pi', 'admin']

const createSchema = z.object({
  patientId: z.string().trim().min(1),
  description: z.string().trim().min(1),
  severity: z.enum(['mild', 'moderate', 'severe']),
  serious: z.boolean(),
  causality: z.enum(['unrelated', 'unlikely', 'possibly', 'probably', 'definitely']),
  onsetDate: z.string().min(1),
  reportedDate: z.string().min(1),
}).strict()

const notifySchema = z.object({
  id: z.number().int().positive(),
  which: z.enum(['sponsor', 'irb']),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { trialId } = await params
  const events = await listAdverseEvents(trialId)
  return NextResponse.json({ events })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { trialId } = await params
  const parsed = createSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid adverse event payload', details: parsed.error.flatten() }, { status: 400 })

  const created = await createAdverseEvent({ trialId, reportedByName: session.name, ...parsed.data })
  await logAudit(session, `logged ${parsed.data.serious ? 'a serious ' : 'an '}adverse event for trial ${trialId}`, parsed.data.patientId)
  return NextResponse.json(created, { status: 201 })
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ trialId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  await params
  const parsed = notifySchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await markAdverseEventNotified(parsed.data.id, parsed.data.which)
  await logAudit(session, `recorded ${parsed.data.which} notification for adverse event ${parsed.data.id}`, null)
  return NextResponse.json({ ok: true })
}
