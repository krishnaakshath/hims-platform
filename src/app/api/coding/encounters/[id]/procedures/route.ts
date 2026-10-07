// POST /api/coding/encounters/[id]/procedures: add a procedure (code, date, performing doctor,
// billed service) to the encounter. Same role semantics as diagnoses. Gate inline first.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ENTRY_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { addProcedureSchema } from '@/lib/coding/validation'
import { INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId } from '@/lib/coding/route-responses'
import { addEncounterProcedure } from '@/lib/queries/coding'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ENTRY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseId((await params).id)
  if (encounterId === null) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = addProcedureSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)

  try {
    const r = await addEncounterProcedure(encounterId, parsed.data, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    return NextResponse.json({ id: r.value.procedureId, warnings: r.value.warnings }, { status: 201 })
  } catch (err) {
    return codingServerError('add procedure', err)
  }
}
