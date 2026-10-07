// GET /api/coding/code-systems: every loaded code-system version (no codes, no PHI), for coding roles.
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ROLES } from '@/lib/role-policy'
import { codingServerError } from '@/lib/coding/route-responses'
import { listCodeSystems } from '@/lib/queries/code-systems'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    return NextResponse.json(await listCodeSystems())
  } catch (err) {
    return codingServerError('list code systems', err, 'Could not load code systems')
  }
}
