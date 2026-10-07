// POST /api/coding/encounters/[id]/diagnoses: add a diagnosis to the encounter. A coder codes it
// (claim required), a pi proposes it, admin codes it without a claim (Task 7 decides by role).
// Gate inline first; the body is read only after it.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ENTRY_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { addDiagnosisSchema } from '@/lib/coding/validation'
import {
  INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId, invalidatePatientDetail,
} from '@/lib/coding/route-responses'
import { addEncounterDiagnosis } from '@/lib/queries/coding'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ENTRY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseId((await params).id)
  if (encounterId === null) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = addDiagnosisSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)

  try {
    const r = await addEncounterDiagnosis(encounterId, parsed.data, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    await invalidatePatientDetail(r.value.patientId)
    return NextResponse.json({ id: r.value.diagnosisId, warnings: r.value.warnings }, { status: 201 })
  } catch (err) {
    return codingServerError('add diagnosis', err)
  }
}
