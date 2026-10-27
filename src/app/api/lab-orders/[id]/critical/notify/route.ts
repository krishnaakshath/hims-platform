// WS4 T12 (spec 3.4 / 3.5): the lab's critical-value call log -- who was called, how, and whether
// the value was read back. Gate LAB_CRITICAL_NOTIFY_ROLES before the body is read; a `pi` must
// also be allowed to verify that order (department rule, criticalNotifyDenial). Audits ids only.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { LAB_CRITICAL_NOTIFY_ROLES } from '@/lib/role-policy'
import { criticalNotifyDenial, logCriticalNotification } from '@/lib/queries/lab-critical'
import { invalidateLabKpis } from '@/lib/queries/hospital-kpis'
import { criticalError, errorResponse, invalidBody, labServerError, parseId, readJsonBody, verifyDenialError } from '@/lib/labs/route-responses'

const notifySchema = z.object({
  notifiedToName: z.string().trim().min(1).max(120),
  channel: z.enum(['phone', 'in_person', 'in_app']),
  readBack: z.boolean(),
}).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!LAB_CRITICAL_NOTIFY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = notifySchema.safeParse(json.body)
  if (!parsed.success) return invalidBody(parsed.error, 'Enter who was called (up to 120 characters), how, and whether the value was read back.')
  const orderId = parseId((await params).id)
  if (orderId === null) return errorResponse(400, 'Invalid order id')

  let result: Awaited<ReturnType<typeof logCriticalNotification>>
  try {
    if (session.role === 'pi') {
      const denial = await criticalNotifyDenial(orderId, session)
      if (denial === 'not_found') return criticalError('not_found')
      if (denial !== null) return verifyDenialError(denial)
    }
    result = await logCriticalNotification(orderId, parsed.data, session)
  } catch (err) {
    return labServerError('lab critical notify', err, 'Could not log the call')
  }
  if (!result.ok) return criticalError(result.error)
  await invalidateLabKpis()
  return NextResponse.json({ ok: true }, { status: 201 })
}
