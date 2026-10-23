import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseId, readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { MEDICATION_PRICE_ROLES } from '@/lib/role-policy'
import { billLegacyDispense, getDispenseById } from '@/lib/queries/medication-dispenses'

// WS2 T8 (spec ruling 7): bills a legacy unbilled dispense (made before dispensing billed itself)
// once, at the medicine's current MRP. The body is strictly empty: the price is never the client's.
const emptyBody = z.object({}).strict()

const ERRORS = {
  already_billed: { status: 409, message: 'This dispense has already been billed' },
  medication_unpriced: { status: 422, message: 'This medicine has no price (MRP) set. Set its MRP on the Pharmacy page first.' },
  quantity_too_large: { status: 422, message: 'This dispense is too large to bill as one line (more than 1000 units)' },
} as const

export async function POST(request: NextRequest, { params }: { params: Promise<{ dispenseId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Pharmacy and admin (the counter roles that also set prices).
  if (!MEDICATION_PRICE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { dispenseId } = await params
  const id = parseId(dispenseId)
  if (id === null) return NextResponse.json({ error: 'Invalid dispenseId' }, { status: 400 })
  if (!(await getDispenseById(id))) return NextResponse.json({ error: 'Dispense not found' }, { status: 404 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  if (!emptyBody.safeParse(json.body).success) return NextResponse.json({ error: 'This request takes no fields' }, { status: 400 })

  const result = await billLegacyDispense(id, session)
  if (!result.ok) {
    if (result.error === 'not_found') return NextResponse.json({ error: 'Dispense not found' }, { status: 404 })
    const e = ERRORS[result.error]
    return NextResponse.json({ error: e.message, code: result.error }, { status: e.status })
  }
  // The audit row was written on the billing transaction.
  return NextResponse.json({ lineId: result.lineId }, { status: 201 })
}
