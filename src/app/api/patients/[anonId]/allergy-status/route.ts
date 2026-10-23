import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { logAudit } from '@/lib/audit'
import { ALLERGY_WRITE_ROLES } from '@/lib/role-policy'
import { patientExists } from '@/lib/queries/patient-exists'
import { allergyStatusSchema, setAllergyStatus } from '@/lib/queries/allergies'
import { pgErrorCode } from '@/lib/db-errors'

// WS1 T3: mark "no known allergies" (or back to "unknown"). Refused (409) while any allergy is
// active: the clinician inactivates those first, so the status never contradicts the list.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLERGY_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = allergyStatusSchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid allergy status' }, { status: 400 })

  if (!(await patientExists(anonId))) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })

  try {
    const result = await setAllergyStatus(anonId, parsed.data.status, session)
    if (result === 'has_active_allergies') {
      return NextResponse.json({ error: 'This patient has active allergies. Remove them first.', code: 'has_active_allergies' }, { status: 409 })
    }
    await logAudit(session, 'set allergy status', anonId, `status=${parsed.data.status}`)
    return NextResponse.json({ allergyStatus: parsed.data.status })
  } catch (err) {
    console.error(`[allergies] status failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not update the allergy status' }, { status: 500 })
  }
}
