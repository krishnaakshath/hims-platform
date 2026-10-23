import { NextRequest, NextResponse } from 'next/server'
import { requireSession, type Session } from '@/lib/auth'
import { RCM_ROLES } from '@/lib/role-policy'
import { preauthCreateSchema } from '@/lib/rcm/validation'
import { createPreauth } from '@/lib/queries/preauths'
import { maybeStartEligibility } from '@/lib/queries/coverage'
import { invalid, rcmErrorResponse, rcmServerError, readJsonBody } from '@/lib/rcm/route-responses'

// SP7: create a draft pre-authorisation with a tariff-priced estimate. WS12 T8 (R4, R5): the
// create is refused for a policy not in force on the planned date or verified inactive; after it
// commits, an NHCX auth-requirements check is started when it can help (never failing the create).
export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!RCM_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = preauthCreateSchema.safeParse(json.body)
  if (!parsed.success) return invalid(parsed.error, 'Invalid pre-authorisation details')

  try {
    const r = await createPreauth(parsed.data, session)
    if (!r.ok) return rcmErrorResponse(r)
    const eligibility = await startEligibilityAfterCreate(parsed.data.policyId, parsed.data.treatingProviderId, session)
    return NextResponse.json({ ...r.value, eligibility }, { status: 201 })
  } catch (err) {
    return rcmServerError('create pre-auth', err, 'Could not save the pre-authorisation')
  }
}

type EligibilityOutcome = { started: true; checkId: number } | { started: false; message: string }

async function startEligibilityAfterCreate(policyId: number, treatingProviderId: number, session: Session): Promise<EligibilityOutcome> {
  try {
    const r = await maybeStartEligibility({ policyId, context: 'preauth', providerId: treatingProviderId, purpose: 'auth-requirements' }, session)
    return r.started ? { started: true, checkId: r.checkId } : { started: false, message: r.message }
  } catch (err) {
    console.error(`[rcm] auto eligibility after pre-auth create failed (${err instanceof Error ? err.name : 'unknown'})`)
    return { started: false, message: 'The NHCX check could not be started: run it from the Insurance tab or record a manual verification' }
  }
}
