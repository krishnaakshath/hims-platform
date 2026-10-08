import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { NHCX_EXCHANGE_ROLES } from '@/lib/role-policy'
import { reviewExchange } from '@/lib/queries/nhcx-review'
import { parseId, rcmError, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP8: confirm (after applying the pre-filled SP7 action) or dismiss an NHCX
// response. Never changes claim status or money by itself (ruling 6).
const schema = z.object({
  decision: z.enum(['confirmed', 'dismissed']),
  note: z.string().trim().min(5).max(500).optional(),
  sendPaymentAck: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.decision === 'dismissed' && !v.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Say why the response is dismissed' })
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!NHCX_EXCHANGE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return rcmError(400, parsed.error.issues[0]?.path[0] === 'note' ? 'Say why the response is dismissed (5 to 500 characters)' : 'Invalid review')
  const id = parseId((await params).id)
  if (id === null) return rcmError(400, 'Invalid exchange id')
  try {
    const r = await reviewExchange(id, parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    return NextResponse.json(r.value)
  } catch (err) {
    return rcmServerError('nhcx review', err, 'Could not save the review')
  }
}
