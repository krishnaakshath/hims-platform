// WS4 T11 (spec 3.4): the ordering doctor (or the attending of the active admission) acknowledges
// having reviewed a result. Gate LAB_SIGNOFF_ROLES before the body is read; the query resolves the
// session's staff-linked provider and audits ids only (the note is stored, never audited).
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { LAB_SIGNOFF_ROLES } from '@/lib/role-policy'
import { signOffLabResult } from '@/lib/queries/lab-signoffs'
import { invalidateDoctorWorkloadCache, invalidateLabKpis } from '@/lib/queries/hospital-kpis'
import { isUniqueViolation } from '@/lib/db-errors'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody, signOffError } from '@/lib/labs/route-responses'

const acknowledgeSchema = z.object({
  note: z.string().trim().max(300).optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SIGNOFF_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  const parsed = acknowledgeSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'The note can be at most 300 characters.')
  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof signOffLabResult>>
  try {
    result = await signOffLabResult(orderId, 'acknowledge', { note: parsed.data.note || null }, session)
  } catch (err) {
    if (isUniqueViolation(err)) return signOffError('acknowledge', 'already_signed')
    return labServerError('lab acknowledge', err, 'Could not acknowledge the result')
  }
  if (!result.ok) return signOffError('acknowledge', result.error)
  await Promise.all([invalidateLabKpis(), invalidateDoctorWorkloadCache(result.providerId, session.name)])
  return NextResponse.json({ ok: true }, { status: 201 })
}
