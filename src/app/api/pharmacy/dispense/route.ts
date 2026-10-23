import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { dispenseMedication } from '@/lib/queries/medication-dispenses'
import { todayIsoIn } from '@/lib/india-time'

const dispenseSchema = z.object({
  patientId: z.string().min(1),
  medicationId: z.number().int(),
  medicationEpisodeId: z.number().int().optional(),
  quantity: z.number().int().positive(),
  notes: z.string().optional(),
  batchId: z.number().int().positive().optional(), // WS5 T5: picked batch; omitted = FEFO
}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['admin', 'pi', 'pharmacy'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = dispenseSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid dispense payload', details: parsed.error.flatten() }, { status: 400 })

  const result = await dispenseMedication({
    patientId: parsed.data.patientId,
    medicationId: parsed.data.medicationId,
    medicationEpisodeId: parsed.data.medicationEpisodeId ?? null,
    quantity: parsed.data.quantity,
    dispensedByName: session.name,
    notes: parsed.data.notes ?? null,
    batchId: parsed.data.batchId ?? null,
    todayIso: todayIsoIn(),
  })
  if (!result.ok) {
    // WS5 T5: stock refusals (insufficient_stock, batch_expired, only_expired_stock,
    // opening_batch_written_off) are 409; batch_mismatch and validation errors are 400.
    const status = result.code === undefined || result.code === 'batch_mismatch' ? 400 : 409
    return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status })
  }

  await logAudit(session, 'dispensed medication', parsed.data.patientId)
  return NextResponse.json({ id: result.dispenseId, ids: result.dispenseIds, allocations: result.allocations }, { status: 201 })
}
