import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { patchDiagnosisSchema } from '@/lib/encounters/diagnosis-validation'
import { updateEncounterDiagnosis, voidEncounterDiagnosis } from '@/lib/queries/encounter-diagnoses'
import { diagnosisErrorResponse, diagnosisFailure } from '../responses'

type Ctx = { params: Promise<{ id: string; diagnosisId: string }> }

async function ids(ctx: Ctx): Promise<{ encounterId: number; diagnosisId: number } | null> {
  const { id, diagnosisId } = await ctx.params
  const encounterId = parseEncounterId(id)
  const dx = parseEncounterId(diagnosisId) // same rule: plain digits within int4
  return encounterId === null || dx === null ? null : { encounterId, diagnosisId: dx }
}

// WS1 T4: change a diagnosis's type or problem-list flag.
export async function PATCH(request: NextRequest, ctx: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const target = await ids(ctx)
  if (!target) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = patchDiagnosisSchema.safeParse(json.body)
  if (!parsed.success || Object.keys(parsed.data).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 })

  const check = await checkEncounterWriter(session, target.encounterId, { allowClosed: true })
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })
  if (check.encounter.status === 'cancelled') return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })

  try {
    const result = await updateEncounterDiagnosis(check.encounter, target.diagnosisId, parsed.data, session)
    if (!result.ok) return diagnosisErrorResponse(result.error)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return diagnosisFailure(err, 'update')
  }
}

// WS1 T4: remove a diagnosis (SP6 soft void: the row stays, marked voided).
export async function DELETE(_request: NextRequest, ctx: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const target = await ids(ctx)
  if (!target) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const check = await checkEncounterWriter(session, target.encounterId, { allowClosed: true })
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })
  if (check.encounter.status === 'cancelled') return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })

  try {
    const result = await voidEncounterDiagnosis(check.encounter, target.diagnosisId, session)
    if (!result.ok) return diagnosisErrorResponse(result.error)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return diagnosisFailure(err, 'remove')
  }
}
