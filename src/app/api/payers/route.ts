import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { listPayers } from '@/lib/queries/payers'
import { PAYER_LIST_ROLES } from '@/lib/role-policy'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Wave I: was any signed-in role; now the registration form and billing's eligibility check.
  if (!PAYER_LIST_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const payers = await listPayers()
  return NextResponse.json(payers)
}
