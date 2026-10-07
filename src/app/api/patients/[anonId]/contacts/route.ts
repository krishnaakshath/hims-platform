import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { PATIENT_PROFILE_EDIT_ROLES } from '@/lib/role-policy'
import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import { getIdentitySnapshot, replacePatientContacts } from '@/lib/queries/patient-profile'
import { contactsReplaceSchema, guardianProblem } from '@/lib/validation/patient-registration'
import { todayIsoIn } from '@/lib/india-time'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'

// Replaces the patient's NOK/guardian/emergency contacts as a whole. A minor
// (under 18 on today's Asia/Kolkata date) must keep a guardian contact.
export async function PUT(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PATIENT_PROFILE_EDIT_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { anonId } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
  const parsed = contactsReplaceSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid contacts', details: parsed.error.flatten() }, { status: 400 })

  const current = await getIdentitySnapshot(anonId)
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const problem = guardianProblem(parsed.data.contacts, current.dob, todayIsoIn())
  if (problem) return NextResponse.json({ error: problem }, { status: 400 })

  try {
    await replacePatientContacts(anonId, parsed.data.contacts, session)
  } catch (err) {
    console.error(`[patients] contacts update failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  try {
    await invalidateCache(patientDetailCacheKey(anonId))
  } catch (err) {
    console.error(`[patients] detail cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
  }
  return NextResponse.json({ ok: true })
}
