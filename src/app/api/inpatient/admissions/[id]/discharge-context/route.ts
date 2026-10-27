import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { pgErrorCode } from '@/lib/db-errors'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { invalidIdResponse, parseId } from '@/lib/http'
import { getAdmissionById } from '@/lib/queries/admissions'
import { loadDischargeContext } from '@/lib/queries/discharge-context'
import { DISCHARGE_ROLES } from '@/lib/role-policy'

// WS3 T6: what the discharge dialog pre-fills (spec 3.2 items 13-14): the stay's diagnoses, the
// MAR drugs of the last 24 h and the dues. The discharge route's own gate: DISCHARGE_ROLES, and a
// pi only for the stays they attend. Audited with ids only.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!DISCHARGE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admissionId = parseId((await params).id)
  if (admissionId === null) return invalidIdResponse()

  try {
    const admission = await getAdmissionById(admissionId)
    if (!admission) return NextResponse.json({ error: 'Admission not found', code: 'not_found' }, { status: 404 })
    if (session.role === 'pi') {
      const providerMatch = await resolveDoctorQueueProvider(session)
      if (!providerMatch || admission.attendingProviderId !== providerMatch.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }
    const context = await loadDischargeContext(admissionId)
    if (!context) return NextResponse.json({ error: 'Admission not found', code: 'not_found' }, { status: 404 })
    await logAudit(session, 'viewed discharge context', admission.patientId, `admission=${admissionId}`)
    return NextResponse.json(context)
  } catch (err) {
    console.error(`[discharge context] read failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not load the discharge details' }, { status: 500 })
  }
}
