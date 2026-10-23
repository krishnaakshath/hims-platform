import { NextRequest, NextResponse } from 'next/server'
import { trialsEnabled } from '@/lib/features'
import { trialsOffResponse } from '@/lib/features-gate'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listAllTrials } from '@/lib/queries/trials'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!trialsEnabled()) return trialsOffResponse()
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  await logAudit(session, 'viewed trials list', null)
  const rows = await listAllTrials()
  return NextResponse.json({ trials: rows })
}
