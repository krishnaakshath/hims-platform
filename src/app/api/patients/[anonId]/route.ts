import { NextRequest, NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { getPatientDetail, deletePatient, PatientHasFinancialRecordsError } from '@/lib/queries/patients'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'
import { toAadhaarView } from '@/lib/patient-identity'

export async function GET(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  // RBAC ruling 1: full patient detail is clinical. Billing's payer prefill
  // uses ./primary-payer instead.
  if (!CLINICAL_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params

  const detail = await getPatientDetail(anonId)

  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, 'viewed patient detail', anonId)

  // The detail object carries the Aadhaar SUMMARY (last4 included); only the
  // role view goes on the wire: masked for admin/crc, status alone otherwise.
  return NextResponse.json({ ...detail, aadhaar: toAadhaarView(detail.aadhaar, session.role) })
}

// Admin-only: permanently removes a patient chart (and everything that
// references it) from this app -- for correcting a real mistake, e.g. a
// duplicate created by a mis-confirmed identity match, or a chart added
// with wrong details. This is the app's own single-sourced copy of the
// chart; there's no separate upstream record left to reconcile against.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ anonId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { anonId } = await params
  // One transaction: the chart, every row referencing it and the audit entry
  // commit together or not at all.
  let deleted: boolean
  try {
    deleted = await deletePatient(anonId, { session })
  } catch (err) {
    // SP4: tax records (issued bills, receipts, refunds) must be kept.
    if (err instanceof PatientHasFinancialRecordsError) return NextResponse.json({ error: err.message }, { status: 409 })
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[patients] delete failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not delete the patient record' }, { status: 500 })
  }
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({ ok: true })
}
