import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { pgErrorCode } from '@/lib/db-errors'
import { todayIsoIn } from '@/lib/india-time'
import { listMedicationRound } from '@/lib/queries/medication-round'
import { CLINICAL_ROLES } from '@/lib/role-policy'

// WS3 T7: the nursing station's medication round (spec 3.2 item 15) -- CLINICAL_ROLES.
// ?date=YYYY-MM-DD (IST day, default today) & ward=<ward name> (optional).
const querySchema = z.object({
  date: z.iso.date().optional(),
  ward: z.string().trim().min(1).max(100).optional(),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid round query' }, { status: 400 })
  const date = parsed.data.date ?? todayIsoIn()

  try {
    const rows = await listMedicationRound(date, parsed.data.ward ?? null)
    await logAudit(session, 'viewed medication round', null)
    return NextResponse.json({ date, rows })
  } catch (err) {
    console.error(`[medication round] read failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not load the medication round' }, { status: 500 })
  }
}
