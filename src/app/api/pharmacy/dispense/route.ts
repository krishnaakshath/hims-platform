import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { dispenseMedication } from '@/lib/queries/medication-dispenses'

const dispenseSchema = z.object({
  patientId: z.string().min(1),
  medicationId: z.number().int(),
  medicationEpisodeId: z.number().int().optional(),
  quantity: z.number().int().positive(),
  notes: z.string().optional(),
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi', 'pharmacy'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = dispenseSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid dispense payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await dispenseMedication({
    patientId: parsed.data.patientId,
    medicationId: parsed.data.medicationId,
    medicationEpisodeId: parsed.data.medicationEpisodeId ?? null,
    quantity: parsed.data.quantity,
    dispensedByName: session.name,
    notes: parsed.data.notes ?? null,
  })
  if (!result.ok) {
    const isNotEnoughStock = result.error === 'Not enough stock on hand for this quantity'
    return NextResponse.json({ error: result.error }, { status: isNotEnoughStock ? 409 : 400 })
  }

  await logAudit(session, 'dispensed medication', parsed.data.patientId)
  return NextResponse.json({ id: result.dispenseId }, { status: 201 })
}
