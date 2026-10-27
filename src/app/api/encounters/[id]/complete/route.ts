import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { DIAGNOSIS_MISSING_BODY, VISIT_HAS_PERFORMED_ORDERS_BODY, encounterResponse, visitBilledBody } from '@/lib/encounters/encounter-projection'
import { completeEncounter, completeEncounterSchema } from '@/lib/queries/encounter-workspace'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'

// WS1 T5 (spec ruling 4): complete a visit from the workspace. An OPD visit with no live diagnosis
// needs { noDiagnosisReason } (5-300 chars), else 409 diagnosis_missing. Audit rows come from
// completeEncounter ("recorded no-diagnosis reason") and transitionEncounter ("encounter status
// changed to completed"), both with the encounter id only; the reason text is never audited or
// echoed. Warnings (no_vitals, unsigned_notes) never block.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  const parsed = completeEncounterSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'The reason must be 5 to 300 characters.' }, { status: 400 })

  const { id } = await params
  const encounterId = parseEncounterId(id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })

  const check = await checkEncounterWriter(session, encounterId)
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })

  try {
    const result = await completeEncounter(encounterId, session, { noDiagnosisReason: parsed.data.noDiagnosisReason, actingProviderId: check.actingProviderId })
    if (!result.ok) {
      if (result.error === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (result.error === 'not_owner') return NextResponse.json({ error: 'Forbidden', code: 'not_owner' }, { status: 403 })
      if (result.error === 'diagnosis_missing') return NextResponse.json(DIAGNOSIS_MISSING_BODY, { status: 409 })
      if (result.error === 'visit_billed') return NextResponse.json(visitBilledBody(result.invoiceNumber), { status: 409 }) // WS2 T14
      if (result.error === 'visit_has_performed_orders') return NextResponse.json(VISIT_HAS_PERFORMED_ORDERS_BODY, { status: 409 }) // WS2 T14
      return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
    }
    // WS2 T14: `charges` is the consultation outcome (captured now, already on the bill, or why not).
    return NextResponse.json({ encounter: encounterResponse(result.encounter), warnings: result.warnings, charges: result.charges })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[encounters] complete failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not complete the visit' }, { status: 500 })
  }
}
