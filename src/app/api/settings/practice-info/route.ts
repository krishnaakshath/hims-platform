import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updatePracticeInfo } from '@/lib/queries/settings'

const practiceInfoSchema = z.object({
  practiceName: z.string().trim().min(1),
  practiceSite: z.string().trim().min(1),
  practiceTimezone: z.string().trim().min(1),
}).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden — admin only' }, { status: 403 })

  const parsed = practiceInfoSchema.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await updatePracticeInfo(parsed.data)
  await logAudit(session, 'updated practice information', null)
  return NextResponse.json({ ok: true })
}
