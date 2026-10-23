import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { readJsonBody } from '@/lib/http'
import { getEncounterById } from '@/lib/queries/encounters'
import { listEncounterProcedures, orderProcedure, orderProcedureSchema } from '@/lib/queries/procedure-orders'
import { CLINICAL_WRITE_ROLES, WORKSPACE_READ_ROLES } from '@/lib/role-policy'

// WS2 T11: order a procedure on the visit (the visit's doctor, or admin); it is billed at order
// time. A blocked or unpriced charge keeps the procedure and comes back as `charge`.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseEncounterId((await params).id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid visit id' }, { status: 400 })
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = orderProcedureSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid procedure order' }, { status: 400 })

  try {
    const check = await checkEncounterWriter(session, encounterId)
    if (!check.ok) return NextResponse.json(check.body, { status: check.status })
    const r = await orderProcedure(check.encounter, parsed.data, session)
    if (!r.ok) {
      if (r.error === 'visit_closed') return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
      return NextResponse.json({ error: 'Choose an active procedure.', code: 'service_not_procedure' }, { status: 422 })
    }
    return NextResponse.json({ procedureId: r.procedureId, charge: r.charge }, { status: 201 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[procedures] order failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not order the procedure' }, { status: 500 })
  }
}

// WS2 T11: the visit's procedures with their billing state (the workspace Procedures panel).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!WORKSPACE_READ_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const encounterId = parseEncounterId((await params).id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid visit id' }, { status: 400 })
  try {
    const encounter = await getEncounterById(encounterId)
    if (!encounter) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const procedures = await listEncounterProcedures(encounterId)
    await logAudit(session, 'viewed visit procedures', encounter.patientId, `encounter=${encounterId}`)
    return NextResponse.json({ procedures })
  } catch (err) {
    console.error(`[procedures] list failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not load the procedures' }, { status: 500 })
  }
}
