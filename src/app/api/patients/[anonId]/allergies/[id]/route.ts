import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { parseId, readJsonBody } from '@/lib/http'
import { logAudit } from '@/lib/audit'
import { ALLERGY_WRITE_ROLES } from '@/lib/role-policy'
import { inactivateAllergy, inactivateAllergySchema } from '@/lib/queries/allergies'
import { pgErrorCode } from '@/lib/db-errors'

// WS1 T3: inactivate one allergy (body `{ "active": false }`); rows are kept for the record.
// 404 when the allergy is not an active allergy of this patient.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ anonId: string; id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLERGY_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId, id } = await params
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = inactivateAllergySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid allergy change' }, { status: 400 })
  const allergyId = parseId(id)
  if (allergyId === null) return NextResponse.json({ error: 'Invalid allergy id' }, { status: 400 })

  try {
    const done = await inactivateAllergy(anonId, allergyId, session)
    if (!done) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    await logAudit(session, 'inactivated allergy', anonId, `allergy=${allergyId}`)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error(`[allergies] inactivate failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not update the allergy' }, { status: 500 })
  }
}
