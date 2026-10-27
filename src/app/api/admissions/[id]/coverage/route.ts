import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { RETRY_MESSAGE, isRetryableConflict, pgErrorCode } from '@/lib/db-errors'
import { invalidIdResponse, parseId, readJsonBody } from '@/lib/http'
import { ADMISSION_COVERAGE_MODES } from '@/lib/insurance/coverage'
import { updateAdmissionCoverage, type AdmissionCoverageCheckError } from '@/lib/queries/admission-coverage'
import { maybeStartEligibility } from '@/lib/queries/coverage'
import { ADMISSION_COVERAGE_ROLES } from '@/lib/role-policy'

// WS12 T9 (spec R4, R12): re-record an active admission's payer, pre-auth and deposit. Same block
// rules as at admission (a cashless stay whose cover blocks is refused unless it is an emergency
// admission). Fixed messages; never echo input. Audit: ids and enums only (upsertAdmissionCoverage).
const positiveInt = z.number().int().positive()
const bodySchema = z.object({
  mode: z.enum(ADMISSION_COVERAGE_MODES),
  policyId: positiveInt.optional(),
  preauthId: positiveInt.optional(),
  depositRequiredPaise: z.number().int().min(0).max(1_000_000_000).optional(),
}).strict().superRefine((b, ctx) => {
  if (b.mode === 'self_pay' && (b.policyId !== undefined || b.preauthId !== undefined)) ctx.addIssue({ code: 'custom', path: ['mode'], message: 'Self-pay takes no policy or pre-authorisation' })
  if (b.mode !== 'self_pay' && b.policyId === undefined) ctx.addIssue({ code: 'custom', path: ['policyId'], message: 'Choose the policy' })
})

const ERRORS: Record<AdmissionCoverageCheckError | 'not_found', { status: number; error: string }> = {
  not_found: { status: 404, error: 'Admission not found or already discharged' },
  policy_mismatch: { status: 404, error: 'Policy not found for this patient' },
  preauth_mismatch: { status: 409, error: 'That pre-authorisation cannot be used for this admission.' },
  preauth_closed: { status: 409, error: 'That pre-authorisation was rejected or cancelled.' },
  coverage_blocked: { status: 409, error: 'The policy does not cover this admission today. Fix the policy or record the stay as self-pay.' },
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ADMISSION_COVERAGE_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const admissionId = parseId((await params).id)
  if (admissionId === null) return invalidIdResponse()
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = bodySchema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid coverage payload', details: parsed.error.flatten() }, { status: 400 })
  const b = parsed.data

  try {
    const result = await updateAdmissionCoverage(admissionId, {
      mode: b.mode, policyId: b.policyId ?? null, preauthId: b.preauthId ?? null, depositRequiredPaise: b.depositRequiredPaise,
    }, session)
    if (!result.ok) {
      const mapped = ERRORS[result.error]
      return NextResponse.json({ error: mapped.error, code: result.error, ...(result.verdict ? { state: result.verdict.state } : {}) }, { status: mapped.status })
    }
    // R5: after the commit, an NHCX check for the policy when one can help; never fails the save.
    const eligibility = b.mode !== 'self_pay' && b.policyId !== undefined
      ? await maybeStartEligibility({ policyId: b.policyId, context: 'admission', providerId: result.attendingProviderId }, session)
      : undefined
    return NextResponse.json({ coverage: result.coverage, verdict: result.verdict, ...(eligibility ? { eligibility } : {}) })
  } catch (err) {
    if (isRetryableConflict(err)) return NextResponse.json({ error: RETRY_MESSAGE }, { status: 409 })
    console.error(`[admission coverage] failed (${err instanceof Error ? err.constructor.name : 'unknown'}, code ${pgErrorCode(err) ?? 'unknown'})`)
    return NextResponse.json({ error: 'Could not save the admission coverage' }, { status: 500 })
  }
}
