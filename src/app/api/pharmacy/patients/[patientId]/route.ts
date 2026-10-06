import { NextRequest, NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import { requireSession } from '@/lib/auth'
import { getPatientPharmacyView } from '@/lib/queries/patients'

export async function GET(request: NextRequest, { params }: { params: Promise<{ patientId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!['pharmacy', 'admin'].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { patientId } = await params
  const view = await getPatientPharmacyView(patientId)
  if (!view) return NextResponse.json({ error: 'No patient with that ID' }, { status: 404 })

  // Logs the real, resolved patient id -- not the raw (possibly differently
  // cased or whitespace-padded) input -- which is the whole reason this
  // lookup is its own route rather than a tab folded into /pharmacy
  // (spec Section 4.1): every chart a pharmacist pulls up at the counter
  // gets its own audit-log entry tied to the actual chart.
  await logAudit(session, 'looked up a patient at the pharmacy counter', view.id)

  return NextResponse.json(view)
}
