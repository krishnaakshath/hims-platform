import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { PHARMACY_STOCK_ROLES } from '@/lib/role-policy'
import { WRITE_OFF_REASONS, writeOffBatch } from '@/lib/queries/medication-batches'

// WS5 T4: write off one batch (its whole remaining quantity). The note is checked but not stored.
const writeOffSchema = z.object({
  reason: z.enum(WRITE_OFF_REASONS),
  note: z.string().max(200).optional(),
}).strict()

const REFUSALS = {
  not_found: { status: 404, message: 'Batch not found.' },
  already_written_off: { status: 409, message: 'This batch is already written off.' },
  opening_batch_written_off: { status: 409, message: 'This medication has stock on hand outside any batch, but its OPENING batch is written off. Correct the stock count first.' },
} as const

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PHARMACY_STOCK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = writeOffSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid write-off', details: parsed.error.flatten() }, { status: 400 })

  const result = await writeOffBatch(id, parsed.data.reason, session)
  if (!result.ok) {
    const r = REFUSALS[result.error]
    return NextResponse.json({ error: r.message, code: result.error }, { status: r.status })
  }
  return NextResponse.json({ ok: true })
}
