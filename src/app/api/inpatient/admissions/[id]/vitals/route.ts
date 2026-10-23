import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { nursingVitalsSchema, vitalWarnings } from '@/lib/inpatient/vitals'
import { getAdmissionById } from '@/lib/queries/admissions'
import { listVitals, recordVitals } from '@/lib/queries/vitals'
import { VITALS_ROLES } from '@/lib/role-policy'

// WS3 T7: nursing vitals for an admission (spec 3.2 items 15-16; lane ruling R4: encounter_vitals on
// the admission's IPD encounter). VITALS_ROLES (= CLINICAL_ROLES: admin, crc, pi -- crc is the ward
// staff stand-in). Audit carries ids only, never a value or the notes text.
function logFailure(what: string, err: unknown) {
  console.error(`[nursing vitals] ${what} failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!VITALS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admissionId = parseId((await params).id)
  if (admissionId === null) return invalidIdResponse()

  try {
    const admission = await getAdmissionById(admissionId)
    if (!admission) return NextResponse.json({ error: 'Admission not found', code: 'not_found' }, { status: 404 })
    const rows = await listVitals(admissionId)
    await logAudit(session, 'viewed vitals', admission.patientId, `admission=${admissionId}`)
    return NextResponse.json({ readings: rows.map((r) => ({ ...r, warnings: vitalWarnings(r) })) })
  } catch (err) {
    logFailure('read', err)
    return NextResponse.json({ error: 'Could not load vitals' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!VITALS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admissionId = parseId((await params).id)
  if (admissionId === null) return invalidIdResponse()

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = nursingVitalsSchema().safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid vitals' }, { status: 400 })

  try {
    const result = await recordVitals(admissionId, parsed.data, session)
    if (!result.ok) {
      switch (result.error) {
        case 'not_found': return NextResponse.json({ error: 'Admission not found', code: 'not_found' }, { status: 404 })
        case 'not_admitted': return NextResponse.json({ error: 'Patient is not admitted', code: 'not_admitted' }, { status: 409 })
        case 'no_ipd_encounter': return NextResponse.json({ error: 'This admission has no inpatient visit to chart on', code: 'no_ipd_encounter' }, { status: 409 })
      }
    }
    await logAudit(session, 'recorded vitals', result.row.patientId, `admission=${admissionId} encounter=${result.row.encounterId}`)
    return NextResponse.json({ vitals: { ...result.row, warnings: vitalWarnings(result.row) } }, { status: 201 })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    logFailure('write', err)
    return NextResponse.json({ error: 'Could not record vitals' }, { status: 500 })
  }
}
