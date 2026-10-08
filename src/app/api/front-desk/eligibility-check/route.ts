import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'

// SP8: the hash-based simulated eligibility check is retired (spec §3, no fake
// data). Coverage is checked through NHCX on the patient's policy
// (POST /api/nhcx/eligibility). Kept as a fixed 410 after the original role
// gate so an old client gets a clear answer.
const RETIRED_MESSAGE = 'Simulated eligibility checks are retired; use the NHCX eligibility check on the patient\'s policy'

export async function POST(_request: Request) {
  void _request
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['billing', 'admin', 'crc'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return NextResponse.json({ error: RETIRED_MESSAGE }, { status: 410 })
}
