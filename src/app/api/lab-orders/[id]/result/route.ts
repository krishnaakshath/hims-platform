import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { enterResult } from '@/lib/queries/lab-orders'

const enterResultSchema = z.object({
  value: z.string().min(1),
  unit: z.string().optional(),
  referenceRange: z.string().optional(),
  flag: z.enum(['normal', 'abnormal', 'critical']),
  notes: z.string().optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi', 'labs'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const orderId = Number(id)
  if (!Number.isInteger(orderId)) return NextResponse.json({ error: 'Invalid order id' }, { status: 400 })

  const parsed = enterResultSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid result payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await enterResult(orderId, {
    value: parsed.data.value,
    unit: parsed.data.unit,
    referenceRange: parsed.data.referenceRange,
    flag: parsed.data.flag,
    notes: parsed.data.notes,
    resultedByName: session.name,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 })

  await logAudit(session, 'entered lab result', result.patientId)
  return NextResponse.json({ ok: true })
}
