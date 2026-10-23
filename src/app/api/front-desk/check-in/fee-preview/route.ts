import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CHECK_IN_ROLES } from '@/lib/role-policy'
import { pgErrorCode } from '@/lib/db-errors'
import { checkInFeePreview, patientExists } from '@/lib/queries/auto-charge'
import { getProviderById } from '@/lib/queries/providers'

// WS2 T9: the fees a check-in would capture (consultation, first-visit registration), shown in
// the check-in dialog before submit. Read-only; never writes a charge.
const querySchema = z.object({
  patientId: z.string().regex(/^[A-Za-z0-9-]{1,40}$/),
  providerId: z.coerce.number().int().positive().max(2147483647),
  visitType: z.enum(['inpatient', 'outpatient']),
  urgency: z.enum(['routine', 'urgent', 'emergency']),
}).strict()

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHECK_IN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid fee preview request' }, { status: 400 })
  const q = parsed.data

  try {
    if (!(await patientExists(q.patientId))) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })
    if (!(await getProviderById(q.providerId))) return NextResponse.json({ error: 'Provider not found' }, { status: 404 })
    const preview = await checkInFeePreview(q)
    await logAudit(session, 'viewed check-in fee preview', q.patientId, `provider=${q.providerId}`)
    return NextResponse.json(preview)
  } catch (err) {
    console.error(`[check-in fee preview] failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not load the fees' }, { status: 500 })
  }
}
