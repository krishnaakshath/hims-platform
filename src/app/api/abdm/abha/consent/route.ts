import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { patients } from '@/db/schema'
import { requireSession } from '@/lib/auth'
import { readJsonBody } from '@/lib/http'
import { ABHA_LINK_ROLES } from '@/lib/role-policy'
import { readAbdmConfig } from '@/lib/integrations/config'
import { getAbdmGateway } from '@/lib/abdm/registry'
import { consentTextFor } from '@/lib/abdm/consent'
import { createFlow, getFlow, saveFlow } from '@/lib/abdm/flow-store'
import { abdmErrorResponse, abhaRateLimitResponse, flowExpiredResponse, notConfiguredResponse, withAbdmErrors } from '@/lib/abdm/route-helpers'
import { consentSchema } from '@/lib/validation/abha-flow'
import { recordConsent } from '@/lib/queries/abha-link'

// ABDM consent before an ABHA is created or verified (S1 CRT_ABHA_102).
// GET: the connection state and the exact texts to show. POST: records the
// consent against the text's SHA-256 and starts (or continues) a flow.

function texts(mock: boolean) {
  const cfg = readAbdmConfig()
  const opts = { mock, cfg: cfg.state === 'configured' ? cfg.config : null }
  return { enrolment: consentTextFor('abha_enrolment', opts), verification: consentTextFor('abha_verification', opts)! }
}

export async function GET() {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()
  const status = gw.status()
  return NextResponse.json({ state: status.state, label: status.label, ...texts(gw.source === 'abdm_sandbox_mock') })
}

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!ABHA_LINK_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const limited = await abhaRateLimitResponse(session)
  if (limited) return limited

  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = consentSchema.safeParse(json.body)
  if (!parsed.success) return abdmErrorResponse('invalid_input')
  const body = parsed.data

  const gw = getAbdmGateway()
  if (!gw) return notConfiguredResponse()

  return withAbdmErrors('consent', async () => {
    const t = texts(gw.source === 'abdm_sandbox_mock')
    const text = body.purpose === 'abha_enrolment' ? t.enrolment : t.verification
    if (!text) return abdmErrorResponse('consent_text_missing')
    if (text.sha256 !== body.textSha256) return abdmErrorResponse('consent_missing')

    const flow = body.flowId
      ? await getFlow(body.flowId, session.name)
      : await createFlow({ staffName: session.name, staffUserId: session.userId, patientId: body.patientId ?? null, kind: body.purpose === 'abha_enrolment' ? 'enrolment' : null })
    if (!flow) return flowExpiredResponse()
    const patientId = body.patientId ?? flow.patientId
    if (body.patientId && flow.patientId && body.patientId !== flow.patientId) return abdmErrorResponse('invalid_input')
    if (patientId) {
      const [p] = await getDb().select({ id: patients.id }).from(patients).where(eq(patients.id, patientId))
      if (!p) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { consentId } = await recordConsent({ flowId: flow.flowId, patientId, purpose: body.purpose, givenBy: body.givenBy, textSha256: body.textSha256 }, session)
    await saveFlow({
      ...flow, patientId, consentId, consentPurpose: body.purpose,
      kind: body.purpose === 'abha_enrolment' ? 'enrolment' : flow.kind,
    })
    return NextResponse.json({ flowId: flow.flowId, consentId })
  })
}
