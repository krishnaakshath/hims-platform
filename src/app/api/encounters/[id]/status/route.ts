import { NextRequest, NextResponse } from 'next/server'
import { readJsonBody } from '@/lib/http'
import { requireSession } from '@/lib/auth'
import { ENCOUNTER_STATUS_ROLES } from '@/lib/role-policy'
import { ENCOUNTER_TRANSITION_ROLES, encounterStatusRequestSchema } from '@/lib/encounters/status'
import { transitionEncounter } from '@/lib/queries/encounters'
import { resolveDoctorQueueProvider } from '@/lib/doctor-queue-provider'
import { completeEncounter } from '@/lib/queries/encounter-workspace'
import { DIAGNOSIS_MISSING_BODY, VISIT_HAS_PERFORMED_ORDERS_BODY, encounterResponse, visitBilledBody } from '@/lib/encounters/encounter-projection'
import { RETRY_MESSAGE, isRetryableConflict, pgConstraint, pgErrorCode } from '@/lib/db-errors'

const MAX_INT = 2147483647

// SP3: move a visit along its state machine (src/lib/encounters/status.ts).
// The route gate is ENCOUNTER_STATUS_ROLES; each target status then has its
// own roles (ENCOUNTER_TRANSITION_ROLES), e.g. the front desk may cancel a
// visit but only a doctor or admin completes one. WS1 T5: completing goes through completeEncounter
// with no reason, so an OPD visit with no live diagnosis is 409 diagnosis_missing here too (the
// reason can only be given through POST .../complete).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ENCOUNTER_STATUS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const body: unknown = json.body
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
    const result = to === 'completed'
      ? await completeEncounter(encounterId, session, { actingProviderId })
      : await transitionEncounter(encounterId, to, session, { cancelReason, actingProviderId })
    if (!result.ok) {
      if (result.error === 'diagnosis_missing') return NextResponse.json(DIAGNOSIS_MISSING_BODY, { status: 409 })
      if (result.error === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 })
      if (result.error === 'not_owner') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      if (result.error === 'admission_active') return NextResponse.json({ error: 'This patient is still admitted. Discharge them before cancelling the visit.' }, { status: 409 })
      if (result.error === 'visit_has_performed_orders') return NextResponse.json(VISIT_HAS_PERFORMED_ORDERS_BODY, { status: 409 }) // WS2 T10, T14
      if (result.error === 'visit_billed') return NextResponse.json(visitBilledBody(result.invoiceNumber), { status: 409 }) // WS2 T14
      return NextResponse.json({ error: 'This visit can no longer change to that status.' }, { status: 409 })
    }
    // Explicit projection (M7): no free text (cancel reason) and no internal links ride along.
    // WS2 T14: the automatic charge outcomes (consultation at completion; none otherwise).
    return NextResponse.json({ encounter: encounterResponse(result.encounter), charges: result.charges ?? [] })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[encounters] status change failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'})`)
    return NextResponse.json({ error: 'Could not update the visit' }, { status: 500 })
  }
}
