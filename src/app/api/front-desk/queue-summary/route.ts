import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { CHECK_IN_ROLES } from '@/lib/role-policy'
import { getFrontDeskQueueSummary } from '@/lib/queries/front-desk-queue'

// WS6 T9 (spec D6): queue length, wait estimate and availability per clinical doctor, for the
// check-in dialog's doctor options. Counts and ids only -- no patient data. Same roles as check-in.
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CHECK_IN_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const summary = await getFrontDeskQueueSummary()
  await logAudit(session, 'viewed front desk queue summary', null, `count=${summary.length}`)
  return NextResponse.json({ providers: summary })
}
