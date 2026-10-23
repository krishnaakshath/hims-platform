import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { logAudit } from '@/lib/audit'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { consultPatchSchema } from '@/lib/encounters/consult-validation'
import { EncounterClosedError, upsertConsult } from '@/lib/queries/encounter-clinical'
import { pgErrorCode } from '@/lib/db-errors'

// WS1 T2: create or update the visit's consultation record (one row per encounter). The audit
// row names the encounter only, never the clinical text.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const encounterId = parseEncounterId(id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = consultPatchSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid consultation record' }, { status: 400 })

  const check = await checkEncounterWriter(session, encounterId)
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })

  try {
    const consult = await upsertConsult(check.encounter, parsed.data, session)
    await logAudit(session, 'updated consultation record', check.encounter.patientId, `encounter=${encounterId}`)
    return NextResponse.json({ consult })
  } catch (err) {
    if (err instanceof EncounterClosedError) return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
    console.error(`[encounters] consult save failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not save the consultation record' }, { status: 500 })
  }
}
