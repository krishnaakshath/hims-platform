import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updateAutoClassifySetting } from '@/lib/queries/settings'

const toggleSchema = z.object({ enabled: z.boolean() }).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = toggleSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await updateAutoClassifySetting(parsed.data.enabled)
  await logAudit(session, `set auto-classify to ${parsed.data.enabled}`, null)
  return NextResponse.json({ ok: true })
}
