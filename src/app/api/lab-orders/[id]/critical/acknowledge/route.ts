// WS4 T12 (spec 3.5 item 24): the ordering doctor (or the attending of the active admission)
// acknowledges a critical result, closing its alert and recording an `acknowledge` sign-off in the
// same transaction. Gate LAB_CRITICAL_ACK_ROLES before the body is read; ownership is checked in
// the query through the session's staff link. Audits ids only (the note is stored, never audited).
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { LAB_CRITICAL_ACK_ROLES } from '@/lib/role-policy'
import { acknowledgeCriticalAlert } from '@/lib/queries/lab-critical'
import { invalidateDoctorWorkloadCache, invalidateLabKpis } from '@/lib/queries/hospital-kpis'
import { isUniqueViolation } from '@/lib/db-errors'
import { criticalError, errorResponse, invalidBody, labServerError, parseId, readJsonBody } from '@/lib/labs/route-responses'

const acknowledgeSchema = z.object({
  note: z.string().trim().max(300).optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_CRITICAL_ACK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  const parsed = acknowledgeSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'The note can be at most 300 characters.')
  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof acknowledgeCriticalAlert>>
  try {
    result = await acknowledgeCriticalAlert(orderId, parsed.data.note || null, session)
  } catch (err) {
    if (isUniqueViolation(err)) return criticalError('already_acknowledged')
    return labServerError('lab critical acknowledge', err, 'Could not acknowledge the critical result')
  }
  if (!result.ok) return criticalError(result.error)
  await Promise.all([invalidateLabKpis(), invalidateDoctorWorkloadCache(result.providerId, session.name)])
  return NextResponse.json({ ok: true }, { status: 201 })
}
