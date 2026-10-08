import { NextRequest, NextResponse, after } from 'next/server'
import { z } from 'zod'
import { readAbdmConfig } from '@/lib/integrations/config'
import { safeLog } from '@/lib/integrations/safe-log'
import { checkAbdmCallbackRateLimit } from '@/lib/rate-limit'
import { verifyAbdmCallback } from '@/lib/abdm/callback-auth'
import { recordProfileShare, sendOnShare, type ShareProfile } from '@/lib/queries/abdm-profile-shares'

// ABHA Scan & Share callback from the ABDM gateway (S1 hiecm-scan-and-register.yaml):
// `{bridgeUrl}/api/v3/hip/patient/share`, with the bridge URL set to <app>/api/abdm.
// Session-less. Every check runs before the next stage and before any write:
// size, rate limit, gateway JWT and HIP id, JSON, schema. Bodies are fixed
// strings; nothing from the request is echoed. A retried REQUEST-ID is
// acknowledged again without a second row. The on-share acknowledgement is
// sent after the response.

export const MAX_SHARE_BODY_BYTES = 16 * 1024

const fixed = (status: number, error: string) => NextResponse.json({ error }, { status })
const str = (max: number) => z.union([z.string(), z.number()]).transform((v) => String(v)).pipe(z.string().max(max))
const int = (min: number, max: number) => z.union([z.string(), z.number()]).transform((v) => Number(v)).pipe(z.number().int().min(min).max(max))

const patientSchema = z.object({
  abhaNumber: str(20).optional(),
  abhaAddress: str(80).optional(),
  name: str(200).optional(),
  gender: str(2).optional(),
  yearOfBirth: int(1900, 2200).optional(),
  monthOfBirth: int(1, 12).optional(),
  dayOfBirth: int(1, 31).optional(),
  phoneNumber: str(20).optional(),
  address: z.object({
    line: str(300).optional(),
    district: str(100).optional(),
    state: str(100).optional(),
    pincode: str(10).optional(),
  }).partial().optional(),
})

const shareSchema = z.object({
  intent: z.string().min(1).max(40),
  metaData: z.object({ hipId: z.string().min(1).max(64), context: z.string().regex(/^[A-Za-z0-9]{1,20}$/) }),
  profile: z.object({ patient: patientSchema }),
})

function clientIp(request: NextRequest): string {
  const first = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return first && first.length <= 64 ? first : 'unknown'
}

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get('content-length') ?? '0')
  if (!Number.isFinite(length) || length > MAX_SHARE_BODY_BYTES) return fixed(413, 'Payload too large')

  try {
    const { allowed } = await checkAbdmCallbackRateLimit(clientIp(request))
    if (!allowed) return fixed(429, 'Too many requests')
  } catch {
    return fixed(503, 'Scan and share is not configured')
  }

  const cfg = readAbdmConfig()
  if (cfg.state !== 'configured') return fixed(503, 'Scan and share is not configured')
  const auth = await verifyAbdmCallback(request, cfg.config)
  if (!auth.ok) {
    safeLog('abdm', { action: 'share_callback', httpStatus: auth.status })
    if (auth.status === 503) return fixed(503, 'Scan and share is not configured')
    return auth.status === 401 ? fixed(401, 'Unauthorized') : fixed(403, 'Forbidden')
  }

  const requestId = request.headers.get('request-id')?.trim() ?? ''
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestId)) return fixed(400, 'Invalid request')
  let raw: string
  try {
    raw = await request.text()
  } catch {
    return fixed(400, 'Invalid request')
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_SHARE_BODY_BYTES) return fixed(413, 'Payload too large')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fixed(400, 'Invalid request')
  }
  const parsed = shareSchema.safeParse(body)
  if (!parsed.success) return fixed(400, 'Invalid request')
  if (parsed.data.metaData.hipId !== cfg.config.hipId) return fixed(403, 'Forbidden')

  const p = parsed.data.profile.patient
  const profile: ShareProfile = {
    abhaNumber: p.abhaNumber ?? null, abhaAddress: p.abhaAddress ?? null, name: p.name ?? null, gender: p.gender ?? null,
    yearOfBirth: p.yearOfBirth ?? null, monthOfBirth: p.monthOfBirth ?? null, dayOfBirth: p.dayOfBirth ?? null,
    phone: p.phoneNumber ?? null, addressLine: p.address?.line ?? null, districtName: p.address?.district ?? null,
    stateName: p.address?.state ?? null, pincode: p.address?.pincode ?? null,
  }
  try {
    const r = await recordProfileShare({ requestId, hipId: parsed.data.metaData.hipId, counterId: parsed.data.metaData.context, intent: parsed.data.intent, profile, isMock: false })
    safeLog('abdm', { action: 'share_callback', shareId: r.shareId, outcome: r.duplicate ? 'duplicate' : 'recorded' })
    if (!r.duplicate) after(() => sendOnShare(r.shareId))
  } catch (e) {
    safeLog('abdm', { action: 'share_callback', errorCode: e instanceof Error ? e.name : 'UnknownError' })
    return fixed(500, 'Internal error')
  }
  return NextResponse.json({}, { status: 202 })
}
