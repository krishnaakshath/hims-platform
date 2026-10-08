import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireSession } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { readJsonBody } from '@/lib/http'
import { INTEGRATION_SETTINGS_ROLES } from '@/lib/role-policy'
import { checkIntegrationTestRateLimit } from '@/lib/rate-limit'
import { readAbdmConfig, readNhcxConfig } from '@/lib/integrations/config'
import { ABDM_ERROR_COPY } from '@/lib/abdm/constants'
import { AbdmHttpError, mapAbdmFailure, refreshGatewayToken, resetGatewayTokenCache } from '@/lib/abdm/session'

// SP8: test the ABDM / NHCX connection (admin). A gateway token fetch only;
// NHCX uses the same session (UNVERIFIED U3). Fixed messages; nothing about the
// credentials is returned.
const schema = z.object({ capability: z.enum(['abdm', 'nhcx']) }).strict()

export async function POST(request: NextRequest) {
  const session = await requireSession()
  if (session instanceof NextResponse) return session
  if (!INTEGRATION_SETTINGS_ROLES.includes(session.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    if (!(await checkIntegrationTestRateLimit(session.name)).allowed) return NextResponse.json({ error: ABDM_ERROR_COPY.rate_limited }, { status: 429 })
  } catch {
    return NextResponse.json({ error: 'Service temporarily unavailable' }, { status: 503 })
  }
  const json = await readJsonBody(request)
  if (!json.ok) return json.response
  const parsed = schema.safeParse(json.body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  const { capability } = parsed.data

  const abdm = readAbdmConfig()
  const nhcxState = capability === 'nhcx' ? readNhcxConfig().state : abdm.state
  if (nhcxState === 'mock') {
    await logAudit(session, `${capability}: tested connection`, null, 'ok=true mock=true')
    return NextResponse.json({ ok: true, mock: true })
  }
  if (nhcxState === 'not_configured' || abdm.state !== 'configured') return NextResponse.json({ ok: false, message: capability === 'nhcx' ? 'NHCX is not configured' : ABDM_ERROR_COPY.not_configured })
  resetGatewayTokenCache()
  try {
    const { expiresIn } = await refreshGatewayToken(abdm.config)
    await logAudit(session, `${capability}: tested connection`, null, 'ok=true')
    return NextResponse.json({ ok: true, expiresInSeconds: expiresIn })
  } catch (e) {
    await logAudit(session, `${capability}: tested connection`, null, 'ok=false')
    const failure = mapAbdmFailure(e instanceof AbdmHttpError ? e.status : null)
    return NextResponse.json({ ok: false, message: ABDM_ERROR_COPY[failure === 'otp_invalid' || failure === 'invalid_input' ? 'abdm_unavailable' : failure] })
  }
}
