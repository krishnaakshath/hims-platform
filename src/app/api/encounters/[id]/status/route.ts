import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { ENCOUNTER_STATUS_ROLES } from '@/lib/role-policy'
import { ENCOUNTER_TRANSITION_ROLES, encounterStatusRequestSchema } from '@/lib/encounters/status'
import { transitionEncounter } from '@/lib/queries/encounters'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'

const MAX_INT = 2147483647

// SP3: move a visit along its state machine (src/lib/encounters/status.ts).
// The route gate is ENCOUNTER_STATUS_ROLES; each target status then has its
// own roles (ENCOUNTER_TRANSITION_ROLES), e.g. the front desk may cancel a
// visit but only a doctor or admin completes one.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ENCOUNTER_STATUS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = encounterStatusRequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid status change' }, { status: 400 })

  const { id } = await params
  const encounterId = /^\d+$/.test(id) ? Number(id) : NaN
  if (!Number.isInteger(encounterId) || encounterId <= 0 || encounterId > MAX_INT) {
    return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })
  }

  const { to, cancelReason } = parsed.data
  if (!ENCOUNTER_TRANSITION_ROLES[to].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    const result = await transitionEncounter(encounterId, to, session, { cancelReason })
    if (!result.ok) {
      if (result.error === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      return NextResponse.json({ error: 'This visit can no longer change to that status.' }, { status: 409 })
    }
    return NextResponse.json({ encounter: result.encounter })
  } catch (err) {
    console.error(`[encounters] status change failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not update the visit' }, { status: 500 })
  }
}
