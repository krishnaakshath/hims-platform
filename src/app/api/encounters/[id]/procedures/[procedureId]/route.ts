import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { cancelProcedure } from '@/lib/queries/procedure-orders'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'

// WS2 T11: cancel a procedure ordered on the visit. The procedure is soft-voided (SP6) and its line
// voided; a line on a finalised invoice is left alone and `billing: 'credit_note_needed'` says so.
export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string; procedureId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const p = await params
  const encounterId = parseEncounterId(p.id)
  const procedureId = parseEncounterId(p.procedureId) // same int4 id rule
  if (encounterId === null || procedureId === null) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  try {
    const check = await checkEncounterWriter(session, encounterId)
    if (!check.ok) return NextResponse.json(check.body, { status: check.status })
    const r = await cancelProcedure(check.encounter, procedureId, session)
    if (!r.ok) {
      if (r.error === 'not_found') return NextResponse.json({ error: 'Procedure not found' }, { status: 404 })
      if (r.error === 'already_void') return NextResponse.json({ error: 'This procedure is already cancelled.', code: 'already_void' }, { status: 409 })
      if (r.error === 'coded') return NextResponse.json({ error: 'This procedure is coded; raise a coding query to change it.', code: 'coded' }, { status: 409 })
      return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
    }
    return NextResponse.json({ ok: true, billing: r.billing })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[procedures] cancel failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not cancel the procedure' }, { status: 500 })
  }
}
