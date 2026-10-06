import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getPatientIdentityForPrint } from '@/lib/queries/patients'
import { listOrdersForPatient } from '@/lib/queries/lab-orders'

// Same roles as /labs itself.
const ALLOWED_ROLES = ['admin', 'pi', 'crc', 'labs']

export async function GET(request: NextRequest, { params }: { params: Promise<{ patientId: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ALLOWED_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { patientId } = await params
  const identity = await getPatientIdentityForPrint(patientId)
  if (!identity) return NextResponse.json({ error: 'No patient with that ID' }, { status: 404 })

  const orders = await listOrdersForPatient(identity.id)
  await logAudit(session, 'viewed patient lab reports', identity.id)

  return NextResponse.json({ ...identity, orders })
}
