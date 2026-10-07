// GET /api/coding/code-systems: every loaded code-system version (no codes, no PHI), for coding roles.
import { NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ROLES } from '@/lib/role-policy'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { listCodeSystems } from '@/lib/queries/code-systems'

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    return NextResponse.json(await listCodeSystems())
  } catch (err) {
    console.error(`[coding] list code systems failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not load code systems' }, { status: 500 })
  }
}
