import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { logAudit } from '@/lib/audit'
import { ALLERGY_WRITE_ROLES } from '@/lib/role-policy'
import { patientExists } from '@/lib/queries/patient-exists'
import { addAllergy, addAllergySchema } from '@/lib/queries/allergies'
import { pgErrorCode } from '@/lib/db-errors'

// WS1 T3: record one allergy; the patient's allergy status becomes "recorded". Allergies are
// patient-level (not tied to one visit), so any ALLERGY_WRITE_ROLES member may record them.
// The audit row carries the allergy id only, never the allergen or reaction text.
export async function POST(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLERGY_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = addAllergySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid allergy' }, { status: 400 })

  if (!(await patientExists(anonId))) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  try {
    const row = await addAllergy(anonId, parsed.data, session)
    await logAudit(session, 'recorded allergy', anonId, `allergy=${row.id}`)
    return NextResponse.json({
      allergy: { id: row.id, allergen: row.allergen, reaction: row.reaction, severity: row.severity, recordedByName: row.recordedByName, recordedAt: row.recordedAt },
    }, { status: 201 })
  } catch (err) {
    console.error(`[allergies] add failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not record the allergy' }, { status: 500 })
  }
}
