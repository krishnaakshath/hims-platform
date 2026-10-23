// WS4 T11 (spec 3.4): an optional co-sign of a verified result by the ordering doctor (or the
// attending of the active admission), with the signer's typed name. Gate LAB_SIGNOFF_ROLES before
// the body is read; audits ids only (the typed name and note are never audited or echoed).
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { LAB_SIGNOFF_ROLES } from '@/lib/role-policy'
import { signOffLabResult } from '@/lib/queries/lab-signoffs'
import { invalidateDoctorWorkloadCache, invalidateLabKpis } from '@/lib/queries/hospital-kpis'
import { isUniqueViolation } from '@/lib/db-errors'
import { errorResponse, invalidBody, labServerError, parseId, readJsonBody, signOffError } from '@/lib/labs/route-responses'

const cosignSchema = z.object({
  typedName: z.string().trim().min(1).max(120),
  note: z.string().trim().max(300).optional(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_SIGNOFF_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = cosignSchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Type your name (up to 120 characters) to co-sign; a note can be at most 300 characters.')
  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof signOffLabResult>>
  try {
    result = await signOffLabResult(orderId, 'cosign', { note: parsed.data.note || null, typedName: parsed.data.typedName }, session)
  } catch (err) {
    if (isUniqueViolation(err)) return signOffError('cosign', 'already_signed')
    return labServerError('lab co-sign', err, 'Could not co-sign the result')
  }
  if (!result.ok) return signOffError('cosign', result.error)
  await Promise.all([invalidateLabKpis(), invalidateDoctorWorkloadCache(result.providerId, session.name)])
  return NextResponse.json({ ok: true }, { status: 201 })
}
