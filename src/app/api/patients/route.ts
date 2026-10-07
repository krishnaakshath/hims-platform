import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES, REGISTRATION_ROLES } from '@/lib/role-policy'
import { invalidateCache, patientListCacheKey } from '@/lib/cache'
import { listPatientsWithStatus } from '@/lib/queries/patients'
import { getPayerById } from '@/lib/queries/payers'
import { registerPatient } from '@/lib/queries/patient-registration'
import { patientRegistrationSchema } from '@/lib/validation/patient-registration'
import { isUniqueViolation, pgConstraint, pgErrorCode } from '@/lib/db-errors'

export async function GET(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // RBAC ruling 1: patient JSON is clinical -- frontdesk's patient views are
  // rendered server-side from the query functions, not this API.
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const trialId = request.nextUrl.searchParams.get('trialId')
  const patientsWithStatus = await listPatientsWithStatus(trialId)

  await logAudit(session, 'viewed patient list', null)

  return NextResponse.json({ patients: patientsWithStatus })
}

// Patient registration (Indian patient master, SP1). Gate first, then the
// strict zod schema, then ONE transaction in registerPatient (patient row,
// contacts, Aadhaar value-or-decline, optional KYC, UHID, audit rows). Responses never
// echo the submitted body: validation details carry fixed messages only, the
// 201 is just { id, uhid }, and any unmapped failure is a generic 500.
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // Patient registration (inpatient and outpatient) is front desk's job
  // exclusively, admin kept as the practice-wide override -- crc previously
  // had this too, removed per explicit product direction.
  if (!REGISTRATION_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
  const parsed = patientRegistrationSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid registration', details: parsed.error.flatten() }, { status: 400 })

  if (parsed.data.primaryPayerId !== undefined) {
    const payer = await getPayerById(parsed.data.primaryPayerId)
    if (!payer) return NextResponse.json({ error: 'primaryPayerId does not reference a real payer' }, { status: 400 })
  }

  let registered: Awaited<ReturnType<typeof registerPatient>>
  try {
    registered = await registerPatient(parsed.data, session)
  } catch (err) {
    if (isUniqueViolation(err, 'patients_abha_number_unique')) {
      return NextResponse.json({ error: 'This ABHA number is already registered to another patient' }, { status: 409 })
    }
    if (isUniqueViolation(err, 'patients_abha_address_unique')) {
      return NextResponse.json({ error: 'This ABHA address is already registered to another patient' }, { status: 409 })
    }
    // Never log the error itself: a drizzle error message carries the query
    // params (patient demographics, ABHA). Code and constraint only.
    console.error(`[patients] registration failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Registration failed' }, { status: 500 })
  }

  // Audit rows were committed with the registration (inside registerPatient).
  // The cache bust runs after commit; a cache failure must not turn a
  // committed registration into an error, and only the error class is logged.
  const { id, uhid } = registered
  try {
    await invalidateCache(patientListCacheKey(null))
  } catch (err) {
    console.error(`[patients] list cache invalidation failed (${err instanceof Error ? err.name : typeof err})`)
  }
  return NextResponse.json({ id, uhid }, { status: 201 })
}
