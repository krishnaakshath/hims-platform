import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { addDiagnosisSchema } from '@/lib/encounters/diagnosis-validation'
import { addEncounterDiagnosis } from '@/lib/queries/encounter-diagnoses'
import { diagnosisErrorResponse, diagnosisFailure } from './responses'

// WS1 T4 (spec ruling 5): add a coded (current WHO ICD-10) or free-text diagnosis to the visit.
// Allowed after completion until SP6 codes the encounter (coding_locked); refused on a cancelled
// visit. The audit row (written with the diagnosis) carries ids only.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const encounterId = parseEncounterId(id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = addDiagnosisSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Choose a code or type a diagnosis' }, { status: 400 })

  const check = await checkEncounterWriter(session, encounterId, { allowClosed: true })
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })
  if (check.encounter.status === 'cancelled') return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })

  try {
    const result = await addEncounterDiagnosis(check.encounter, parsed.data, session)
    if (!result.ok) return diagnosisErrorResponse(result.error)
    return NextResponse.json({ diagnosis: result.diagnosis }, { status: 201 })
  } catch (err) {
    return diagnosisFailure(err, 'add')
  }
}
