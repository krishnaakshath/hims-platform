import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '@/lib/auth'
import { ENCOUNTER_STATUS_ROLES } from '@/lib/role-policy'
import { ENCOUNTER_TRANSITION_ROLES, encounterStatusRequestSchema } from '@/lib/encounters/status'
import { transitionEncounter } from '@/lib/queries/encounters'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'

const MAX_INT = 2147483647

// SP3: move a visit along its state machine (src/lib/encounters/status.ts).
// The route gate is ENCOUNTER_STATUS_ROLES; each target status then has its
// own roles (ENCOUNTER_TRANSITION_ROLES), e.g. the front desk may cancel a
// visit but only a doctor or admin completes one.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ENCOUNTER_STATUS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const parsed = encounterStatusRequestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid status change' }, { status: 400 })

  const { id } = await params
  const encounterId = /^\d+$/.test(id) ? Number(id) : NaN
  if (!Number.isInteger(encounterId) || encounterId <= 0 || encounterId > MAX_INT) {
    return NextResponse.json({ error: 'Invalid encounter id' }, { status: 400 })
  }

  const { to, cancelReason } = parsed.data
  if (!ENCOUNTER_TRANSITION_ROLES[to].includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  try {
    // A pi acts as their own linked provider profile and may move only their own visits.
    let actingProviderId: number | null = null
    if (session.role === 'pi') {
      const self = await resolveDoctorQueueProvider(session)
      if (!self) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      actingProviderId = self.id
    }
    const result = await transitionEncounter(encounterId, to, session, { cancelReason, actingProviderId })
    if (!result.ok) {
      if (result.error === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (result.error === 'not_owner') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      if (result.error === 'admission_active') return NextResponse.json({ error: 'This patient is still admitted. Discharge them before cancelling the visit.' }, { status: 409 })
      return NextResponse.json({ error: 'This visit can no longer change to that status.' }, { status: 409 })
    }
    // Explicit projection (M7): no free text (cancel reason) and no internal links ride along.
    const e = result.encounter
    return NextResponse.json({
      encounter: {
        id: e.id, patientId: e.patientId, encounterType: e.encounterType, visitType: e.visitType, status: e.status,
        encounterDate: e.encounterDate, opdToken: e.opdToken, departmentId: e.departmentId, providerId: e.providerId,
        appointmentId: e.appointmentId, admissionId: e.admissionId, checkedInAt: e.checkedInAt,
        statusChangedAt: e.statusChangedAt, statusChangedByName: e.statusChangedByName, completedAt: e.completedAt,
      },
    })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[encounters] status change failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not update the visit' }, { status: 500 })
  }
}
