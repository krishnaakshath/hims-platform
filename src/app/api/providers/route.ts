import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { SCHEDULING_ROLES } from '@/lib/role-policy'
import { listClinicalDoctors } from '@/lib/queries/providers'

// WS6 T8 (spec D6): the doctors of active clinical departments (id, name, department,
// OPD room) for the registration dialog's "Next available" hint, which then reads each
// doctor's slots from GET /api/providers/[id]/slots. Same roles as the slots route.
export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!SCHEDULING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const doctors = await listClinicalDoctors()
  await logAudit(session, 'viewed clinical doctors', null, `count=${doctors.length}`)
  return NextResponse.json({ doctors })
}
