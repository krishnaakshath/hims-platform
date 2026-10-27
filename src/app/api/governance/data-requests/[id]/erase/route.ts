import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { RETRY_MESSAGE, isRetryableConflict } from '@/lib/db-errors'
import { PatientHasFinancialRecordsError } from '@/lib/queries/patients'
import { checkErasure, erasePatientForRequest, restrictPatientForErasure, RetentionAppliesError } from '@/lib/queries/data-principal-requests'

// WS8 T14 (spec D18): act on a DPDP erasure request. Admin only; the admin types the patient's UHID.
// When the retention schedule keeps records (financial, medico-legal or recent medical records) the
// chart is archived and its contact fields, photo and portal credentials are scrubbed -- outcome
// 'restricted' with the reasons. Otherwise the chart is deleted -- outcome 'erased'. This is the only
// route that may call deletePatient, through erasePatientForRequest (tests/api/patients-archive.test.ts).
const bodySchema = z.object({ confirmUhid: z.string().trim().min(1).max(64) }).strict()

const ERRORS = {
  not_found: { status: 404, message: 'Request not found' },
  not_erasure: { status: 409, message: 'Only an erasure request can erase a chart.' },
  closed: { status: 409, message: 'This request is closed.' },
  no_patient: { status: 409, message: 'This request no longer has a patient chart.' },
  uhid_mismatch: { status: 400, message: 'The UHID you typed does not match this patient.' },
  active_admission: { status: 409, message: 'This patient is currently admitted. Discharge them before acting on the erasure.' },
} as const

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const id = parseId((await params).id)
  if (id === null) return invalidIdResponse()
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = bodySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: "Type the patient's UHID to confirm.", code: 'invalid' }, { status: 400 })

  try {
    const check = await checkErasure(id, parsed.data.confirmUhid)
    if (!check.ok) {
      const e = ERRORS[check.error]
      return NextResponse.json({ error: e.message, code: check.error }, { status: e.status })
    }
    if (check.reasons.length > 0) {
      const restricted = await restrictPatientForErasure(check, session)
      if (!restricted.ok) {
        const e = ERRORS[restricted.error]
        return NextResponse.json({ error: e.message, code: restricted.error }, { status: e.status })
      }
      return NextResponse.json({ outcome: 'restricted', reasons: check.reasons })
    }
    const deleted = await erasePatientForRequest(check, session)
    if (!deleted) return NextResponse.json({ error: ERRORS.no_patient.message, code: 'no_patient' }, { status: 409 })
    return NextResponse.json({ outcome: 'erased' })
  } catch (err) {
    if (err instanceof RetentionAppliesError) {
      return NextResponse.json({ error: 'Records that must be kept were added meanwhile; act on the request again.', code: 'retained_records', reasons: err.reasons }, { status: 409 })
    }
    if (err instanceof PatientHasFinancialRecordsError) {
      return NextResponse.json({ error: 'Financial records were added meanwhile; act on the request again.', code: 'retained_records' }, { status: 409 })
    }
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    throw err
  }
}
