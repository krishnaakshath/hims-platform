import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { findLikelyDuplicatePatients } from '@/lib/queries/patients'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['frontdesk', 'admin', 'crc'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const name = request.nextUrl.searchParams.get('name')
  const dob = request.nextUrl.searchParams.get('dob')
  if (!name || !dob) return NextResponse.json({ error: 'name and dob query parameters are required' }, { status: 400 })

  const matches = await findLikelyDuplicatePatients(name, dob)
  await logAudit(session, 'searched for a possible duplicate patient', null)
  return NextResponse.json(matches)
}
