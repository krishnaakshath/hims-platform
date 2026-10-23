import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { startConsultation } from '@/lib/queries/encounter-workspace'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'

const startBodySchema = z.object({}).strict()

// WS1 T3 (spec ruling 2): starting a consultation is explicit and POST-only; opening the
// workspace never mutates. checked_in -> in_consultation; already in consultation answers
// changed:false. The state change is audited by transitionEncounter ("encounter status changed
// to in_consultation", encounter id only); a no-op start changes nothing and writes no audit row.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request, { emptyAs: {} })
  if (!json.ok) return json.response
  if (!startBodySchema.safeParse(json.body).success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })

  const { id } = await params
  const encounterId = parseEncounterId(id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })

  const check = await checkEncounterWriter(session, encounterId)
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })

  try {
    const result = await startConsultation(encounterId, session, check.actingProviderId)
    if (!result.ok) {
      if (result.error === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (result.error === 'not_owner') return NextResponse.json({ error: 'Forbidden', code: 'not_owner' }, { status: 403 })
      return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
    }
    return NextResponse.json({ status: result.status, changed: result.changed })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[encounters] start failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not start the consultation' }, { status: 500 })
  }
}
