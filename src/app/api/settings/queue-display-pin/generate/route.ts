import { NextRequest, NextResponse } from 'next/server'
import { randomInt } from 'crypto'
import { z } from 'zod'
import { readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { setQueueDisplayPin } from '@/lib/queries/settings'

// WS6 T10: a random 6-digit lobby display PIN, returned once to the admin who
// generated it. The PIN is never logged or written to the audit trail.
const bodySchema = z.object({}).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  const parsed = bodySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  const pin = randomInt(0, 1_000_000).toString().padStart(6, '0')
  await setQueueDisplayPin(pin)
  await logAudit(session, 'generated queue display PIN', null)
  return NextResponse.json({ pin })
}
