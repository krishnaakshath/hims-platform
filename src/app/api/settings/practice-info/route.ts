import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { updatePracticeInfo } from '@/lib/queries/settings'
import { isPracticeTimezone } from '@/lib/practice-timezones'

const practiceInfoSchema = z.object({
  practiceName: z.string().trim().min(1),
  practiceSite: z.string().trim().min(1),
  // Only the hospital zones Settings offers (Asia/Kolkata first) -- never a US zone.
  practiceTimezone: z.string().trim().refine(isPracticeTimezone),
}).strict()

export async function PUT(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = practiceInfoSchema.safeParse(json.body)
  if (!parsed.success && parsed.error.issues.some((i) => i.path[0] === 'practiceTimezone')) {
    return NextResponse.json({ error: 'Choose a supported hospital time zone.' }, { status: 400 })
  }
  if (!parsed.success) return NextResponse.json({ error: 'Invalid payload', details: parsed.error.flatten() }, { status: 400 })

  await updatePracticeInfo(parsed.data)
  await logAudit(session, 'updated practice information', null)
  return NextResponse.json({ ok: true })
}
