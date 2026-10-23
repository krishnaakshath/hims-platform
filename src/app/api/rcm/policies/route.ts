import { NextRequest, NextResponse } from 'next/server'
import { requireSession, type Session } from '@/lib/auth'
import { POLICY_WRITE_ROLES } from '@/lib/role-policy'
import { policySchema } from '@/lib/rcm/validation'
import { createPolicy } from '@/lib/queries/rcm-policies'
import { defaultEligibilityProviderId, maybeStartEligibility } from '@/lib/queries/coverage'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: record a patient's insurance policy (front desk at registration/admission, or RCM).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!POLICY_WRITE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = policySchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid policy details')

  try {
    const r = await createPolicy(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    // WS12 T4 (R5): after the create commits, try an NHCX check; it never fails the create.
    const eligibility = await startEligibilityAfterCreate(r.value.policyId, parsed.data.patientId, session)
    return NextResponse.json({ ...r.value, eligibility }, { status: 201 })
  } catch (err) {
    return rcmServerError('create policy', err, 'Could not save the policy')
  }
}

type EligibilityOutcome = { started: boolean; checkId?: number; message?: string }

async function startEligibilityAfterCreate(policyId: number, patientId: string, session: Session): Promise<EligibilityOutcome> {
  try {
    const providerId = await defaultEligibilityProviderId(patientId)
    const r = await maybeStartEligibility({ policyId, context: 'registration', providerId, purpose: 'validation' }, session)
    return r.started ? { started: true, checkId: r.checkId } : { started: false, message: r.message }
  } catch (err) {
    console.error(`[rcm] auto eligibility after policy create failed (${err instanceof Error ? err.name : 'unknown'})`)
    return { started: false, message: 'The NHCX check could not be started: run it from the Insurance tab or record a manual verification' }
  }
}
