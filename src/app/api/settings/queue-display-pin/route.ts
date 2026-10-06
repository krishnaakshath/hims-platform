import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { setQueueDisplayPin } from '@/lib/queries/settings'

// .trim() so a leading/trailing space typo'd on entry doesn't get stored as
// part of the real PIN (and silently mismatch every future comparison).
// min(6), not the original min(4) -- a 4-digit PIN space is small enough to
// be sped through quickly by a guessing script even with GET
// /api/queue-display's own rate limiting (see src/lib/rate-limit.ts).
const pinSchema = z.object({ pin: z.string().trim().min(6).max(32) }).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = pinSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await setQueueDisplayPin(parsed.data.pin)
  await logAudit(session, 'set queue display PIN', null)
  return NextResponse.json({ ok: true })
}
