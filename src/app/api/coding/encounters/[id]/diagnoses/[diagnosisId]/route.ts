// PATCH / DELETE /api/coding/encounters/[id]/diagnoses/[diagnosisId]: change (code, type,
// sequence) or void one of the encounter's diagnoses. Gate inline first, then ids, then body.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ENTRY_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { updateDiagnosisSchema } from '@/lib/coding/validation'
import {
  INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId, invalidatePatientDetail,
} from '@/lib/coding/route-responses'
import { updateEncounterDiagnosis, voidEncounterDiagnosis } from '@/lib/queries/coding'

type Ctx = { params: Promise<{ id: string; diagnosisId: string }> }

async function ids(params: Ctx['params']) {
  const p = await params
  const encounterId = parseId(p.id)
  const diagnosisId = parseId(p.diagnosisId)
  return encounterId === null || diagnosisId === null ? null : { encounterId, diagnosisId }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ENTRY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = await ids(params)
  if (!id) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = updateDiagnosisSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)

  try {
    const r = await updateEncounterDiagnosis(id.encounterId, id.diagnosisId, parsed.data, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    await invalidatePatientDetail(r.value.patientId)
    return NextResponse.json({ id: r.value.diagnosisId, warnings: r.value.warnings })
  } catch (err) {
    return codingServerError('change diagnosis', err)
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ENTRY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = await ids(params)
  if (!id) return invalidCodingId()

  try {
    const r = await voidEncounterDiagnosis(id.encounterId, id.diagnosisId, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    await invalidatePatientDetail(r.value.patientId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return codingServerError('remove diagnosis', err)
  }
}
