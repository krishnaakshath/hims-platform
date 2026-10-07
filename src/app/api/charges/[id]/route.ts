import { NextRequest, NextResponse } from 'next/server'
import { parseId, readJsonBody } from '@/lib/http'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CHARGES_ROLES } from '@/lib/role-policy'
import { getCharge, updateChargeStatus, isAllowedChargeTransition, type ChargeStatus } from '@/lib/queries/charges'

const statusUpdateSchema = z.object({
  status: z.enum(['draft', 'pending_approval', 'approved', 'submitted']),
}).strict()

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHARGES_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { id } = await params
  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const charge = await getCharge(numericId)
  if (!charge) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  await logAudit(session, `viewed charge ${id}`, charge.patientId)
  return NextResponse.json(charge)
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session

  // Advancing a charge draft -> pending_approval -> approved -> submitted is
  // the billing team's approval authority. Pharmacy records that a billable
  // thing happened (via the dispense-billing path) without deciding what to
  // do about it, so it does not get to move a charge through this workflow.
  if (!CHARGES_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = statusUpdateSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid status payload', details: parsed.error.flatten() }, { status: 400 })

  const numericId = parseId(id)
  if (numericId === null) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const existing = await getCharge(numericId)
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const nextStatus = parsed.data.status as ChargeStatus
  if (!isAllowedChargeTransition(existing.status, nextStatus)) {
    return NextResponse.json({ error: `Cannot move a charge from '${existing.status}' to '${nextStatus}'` }, { status: 400 })
  }

  await updateChargeStatus(numericId, nextStatus)
  await logAudit(session, `updated charge ${id} status to ${nextStatus}`, existing.patientId)
  return NextResponse.json({ ok: true })
}
