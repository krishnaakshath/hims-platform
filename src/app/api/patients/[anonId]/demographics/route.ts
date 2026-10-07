import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { DEMOGRAPHICS_CORRECTION_ROLES } from '@/lib/role-policy'
import { invalidateCache, invalidateCacheByPrefix, patientDetailCacheKey, patientListCacheKey, patientListCachePrefix, workbookListCacheKey } from '@/lib/cache'
import { correctPatientDemographics } from '@/lib/queries/patient-profile'
import { demographicsCorrectionSchema } from '@/lib/validation/patient-registration'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'

// Wave C P1-11: correct a typo in the name or date of birth after
// registration (the profile edit cannot change either) -- admin only, with a
// reason. Gate before parsing; the update and its audit row (field names and
// the reason, never the values) commit together in correctPatientDemographics.
// Error bodies are fixed strings: never the submitted name/DOB/reason.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!DEMOGRAPHICS_CORRECTION_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { anonId } = await params

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
  const parsed = demographicsCorrectionSchema.safeParse(body)
  if (!parsed.success) {
    // Field paths and fixed messages only.
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? 'form')))]
    return NextResponse.json({ error: 'Invalid correction', fields }, { status: 400 })
  }

  try {
    const result = await correctPatientDemographics(anonId, parsed.data, session)
    if (result === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
    if (result === 'guardian_required') return NextResponse.json({ error: 'A guardian contact is required for a patient under 18' }, { status: 400 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[patients] demographics correction failed (code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  try {
    await invalidateCache(patientDetailCacheKey(anonId))
    await invalidateCache(patientListCacheKey(null))
    await invalidateCacheByPrefix(patientListCachePrefix())
    await invalidateCache(workbookListCacheKey())
  } catch (err) {
    console.error(`[patients] cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
  }
  return NextResponse.json({ ok: true })
}
