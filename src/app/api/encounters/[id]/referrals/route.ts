import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { logAudit } from '@/lib/audit'
import { CLINICAL_WRITE_ROLES } from '@/lib/role-policy'
import { checkEncounterWriter, parseEncounterId } from '@/lib/encounters/ownership'
import { referralHasTarget, referralSchema } from '@/lib/encounters/diagnosis-validation'
import { EncounterClosedError } from '@/lib/queries/encounter-clinical'
import { ReferralTargetError, createReferral } from '@/lib/queries/referrals'
import { pgErrorCode } from '@/lib/db-errors'

// WS1 T4: refer the patient from an open visit, inside the hospital (department and/or doctor) or
// outside it (facility). The audit row carries ids, kind and urgency only, never the reason or
// the facility.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!CLINICAL_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const encounterId = parseEncounterId(id)
  if (encounterId === null) return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = referralSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid referral' }, { status: 400 })
  if (!referralHasTarget(parsed.data)) return NextResponse.json({ error: 'Choose a department or a doctor to refer to' }, { status: 400 })

  const check = await checkEncounterWriter(session, encounterId)
  if (!check.ok) return NextResponse.json(check.body, { status: check.status })

  try {
    const referral = await createReferral(check.encounter, parsed.data, session)
    await logAudit(session, 'created referral', check.encounter.patientId,
      `encounter=${encounterId} referral=${referral.id} kind=${referral.kind} urgency=${referral.urgency}`)
    return NextResponse.json({ referral }, { status: 201 })
  } catch (err) {
    if (err instanceof EncounterClosedError) return NextResponse.json({ error: 'Visit is closed', code: 'visit_closed' }, { status: 409 })
    if (err instanceof ReferralTargetError) return NextResponse.json({ error: 'That department or doctor was not found' }, { status: 400 })
    console.error(`[encounters] referral failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not save the referral' }, { status: 500 })
  }
}
