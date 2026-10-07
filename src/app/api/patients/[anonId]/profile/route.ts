import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { MLC_UNFLAG_ROLES, PATIENT_PROFILE_EDIT_ROLES } from '@/lib/role-policy'
import { invalidateCache, invalidateCacheByPrefix, patientDetailCacheKey, patientListCacheKey, patientListCachePrefix, workbookListCacheKey } from '@/lib/cache'
import { getIdentitySnapshot, updatePatientProfile } from '@/lib/queries/patient-profile'
import { patientProfileUpdateSchema } from '@/lib/validation/patient-registration'
import { isUniqueViolation, pgConstraint, pgErrorCode } from '@/lib/db-errors'

// Staff profile edit (SP1). Gate, then the strict schema -- which has no
// aadhaar key, so an edit can never wipe or overwrite the stored Aadhaar
// (that is PUT ../aadhaar). The write and its audit rows ('updated patient
// profile' + identity entries) commit together inside updatePatientProfile.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!PATIENT_PROFILE_EDIT_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { anonId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid profile update' }, { status: 400 })
  }
  const parsed = patientProfileUpdateSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid profile update', details: parsed.error.flatten() }, { status: 400 })
  const input = parsed.data

  const current = await getIdentitySnapshot(anonId)
  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Wave C P2-11: a medico-legal flag, once set, is cleared only by an
  // administrator (MLC_UNFLAG_ROLES); any profile editor may still set it.
  if (input.isMlc === false && current.snapshot.isMlc && !MLC_UNFLAG_ROLES.includes(session.role)) {
    return NextResponse.json({ error: 'Only an administrator can clear the MLC flag' }, { status: 403 })
  }
  // Same rule as registration: an MLC number needs the MLC flag (as it will
  // stand after this update).
  if (input.mlcNumber != null && !(input.isMlc ?? current.snapshot.isMlc)) {
    return NextResponse.json({ error: 'MLC number requires the MLC flag' }, { status: 400 })
  }

  try {
    const found = await updatePatientProfile(anonId, input, session)
    if (!found) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  } catch (err) {
    if (isUniqueViolation(err, 'patients_abha_number_unique')) {
      return NextResponse.json({ error: 'This ABHA number is already registered to another patient' }, { status: 409 })
    }
    if (isUniqueViolation(err, 'patients_abha_address_unique')) {
      return NextResponse.json({ error: 'This ABHA address is already registered to another patient' }, { status: 409 })
    }
    // Never log the error itself (drizzle messages carry the query params).
    console.error(`[patients] profile update failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }

  try {
    // The list/search/workbook caches hold phone and address fields too.
    await invalidateCache(patientDetailCacheKey(anonId))
    await invalidateCache(patientListCacheKey(null))
    await invalidateCacheByPrefix(patientListCachePrefix())
    await invalidateCache(workbookListCacheKey())
  } catch (err) {
    console.error(`[patients] cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
  }
  return NextResponse.json({ ok: true })
}
