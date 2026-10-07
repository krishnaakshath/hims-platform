// PATCH / DELETE /api/coding/encounters/[id]/procedures/[procedureId]: change or void one of the
// encounter's procedures. Gate inline first, then ids, then body.
import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { CODING_ENTRY_ROLES } from '@/lib/role-policy'
import { readJsonBody } from '@/lib/follow-ups/route-responses'
import { invalid, parseId } from '@/lib/tariff/route-responses'
import { updateProcedureSchema } from '@/lib/coding/validation'
import { INVALID_CODING_REQUEST, codingErrorResponse, codingServerError, invalidCodingId } from '@/lib/coding/route-responses'
import { updateEncounterProcedure, voidEncounterProcedure } from '@/lib/queries/coding'

type Ctx = { params: Promise<{ id: string; procedureId: string }> }

async function ids(params: Ctx['params']) {
  const p = await params
  const encounterId = parseId(p.id)
  const procedureId = parseId(p.procedureId)
  return encounterId === null || procedureId === null ? null : { encounterId, procedureId }
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ENTRY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = await ids(params)
  if (!id) return invalidCodingId()
  const read = await readJsonBody(request)
  if (!read.ok) return read.response
  const parsed = updateProcedureSchema.safeParse(read.body)
  if (!parsed.success) return invalid(parsed.error, INVALID_CODING_REQUEST)

  try {
    const r = await updateEncounterProcedure(id.encounterId, id.procedureId, parsed.data, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    return NextResponse.json({ id: r.value.procedureId, warnings: r.value.warnings })
  } catch (err) {
    return codingServerError('change procedure', err)
  }
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CODING_ENTRY_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = await ids(params)
  if (!id) return invalidCodingId()

  try {
    const r = await voidEncounterProcedure(id.encounterId, id.procedureId, session)
    if (!r.ok) return codingErrorResponse(r.error, r.issues)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return codingServerError('remove procedure', err)
  }
}
