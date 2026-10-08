import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CHARGE_CAPTURE_ROLES } from '@/lib/role-policy'
import { voidLineSchema } from '@/lib/billing/validation'
import { voidChargeLine } from '@/lib/queries/charge-capture'
import { billingError, billingServerError, invalid, parseId, readJsonBody } from '@/lib/billing/route-responses'

// SP4: void a charge that is not yet invoiced (the row is kept with its reason).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHARGE_CAPTURE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = voidLineSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Give a reason for voiding (at least 5 characters)')

  const id = parseId((await params).id)
  if (id === null) return billingError(400, 'Invalid charge line id')

  try {
    const result = await voidChargeLine(id, parsed.data.reason, session)
    if (!result.ok) {
      return result.error === 'not_found'
        ? billingError(404, 'Charge line not found')
        : billingError(409, 'Only a charge that is not yet invoiced can be voided')
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return billingServerError('void charge', err, 'Could not void the charge')
  }
}
