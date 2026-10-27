import { NextRequest, NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { CLINICAL_ROLES } from '@/lib/role-policy'
import { getPatientDetail } from '@/lib/queries/patients'
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
  // WS8 T13: an archived chart is visible to admin only.
  if (detail.archivedAt && session.role !== 'admin') return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit(session, 'viewed patient detail', anonId)

  // The detail object carries the Aadhaar SUMMARY (last4 included); only the
  // role view goes on the wire: masked for admin/crc, status alone otherwise.
  return NextResponse.json({ ...detail, aadhaar: toAadhaarView(detail.aadhaar, session.role) })
}

// WS8 T13 (spec D17): patients are archived (POST ./archive), never deleted through the API. The
// hard delete (deletePatient) is reachable only from DPDP erasure when no retained records exist.
export async function DELETE() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (session.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json({ error: 'Patients are archived, not deleted. Use Archive.' }, { status: 405 })
}
