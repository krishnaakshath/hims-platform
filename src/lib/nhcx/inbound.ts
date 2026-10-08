import { createHash, randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { claims, nhcxEligibilityChecks, nhcxExchanges, nhcxInboundCalls, preauths, type NhcxExchangeRow } from '@/db/schema'
import { isUniqueViolation } from '@/lib/db-errors'
import { readNhcxConfig, type ConfigResult, type NhcxConfig } from '@/lib/integrations/config'
import { sealPayload } from '@/lib/integrations/payload-vault'
import { safeLog } from '@/lib/integrations/safe-log'
import { logGatewayEvent } from '@/lib/integrations/system-audit'
import { checkNhcxCallbackRateLimit } from '@/lib/rate-limit'
import { parseEligibilityResponse, emptySummary } from '@/lib/fhir/nhcx/eligibility'
import { parseClaimResponseBundle, parseCommunicationRequestTaskBundle, parsePaymentNoticeTaskBundle } from '@/lib/fhir/nhcx/responses'
import { addGatewayClaimNote } from '@/lib/queries/nhcx-exchanges'
import { callerIp, checkCallerIp, verifyNhcxBearer } from './callback-auth'
import { ACCEPTED_INBOUND_ACTIONS, type NhcxEntityType, type NhcxResponseSummary } from './constants'
import { istIsoWithOffset, parseProtocolHeaders, timestampWithin, type ParsedHeaders, type ProtocolHeaders } from './headers'
import { openHcxPayload } from './jwe'

// The NHCX callback receiver (Task 12). One session-less route; every check
// runs in order and before the next stage, and every refusal is a fixed body:
//   config -> size -> caller IP -> rate limit -> bearer JWT (before the body is
//   read) -> body cap and JSON -> JWE decrypt -> protocol headers (ours, fresh)
//   -> replay (api_call_id seen: the same 202, no write) -> correlation (one we
//   issued; refused without a write) -> one transaction that stores the
//   vault-sealed payload, a summary with no free text, review state, a claim
//   note, and the dedupe row.
// Nothing here changes claim status or money (ruling 6).

export type AcceptedInboundAction = (typeof ACCEPTED_INBOUND_ACTIONS)[number]
type SuccessBody = { timestamp: string; api_call_id?: string; correlation_id?: string }
export type InboundResult = { http: 202 | 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503; body: SuccessBody | { error: string } }

export const MAX_CALLBACK_BYTES = 2 * 1024 * 1024
const FIXED = {
  notFound: 'Not found', notConfigured: 'NHCX is not configured', callbacksNotConfigured: 'NHCX callbacks are not configured', tooLarge: 'Payload too large',
  forbidden: 'Forbidden', tooMany: 'Too many requests', unauthorized: 'Unauthorized', invalid: 'Invalid request', unknownCorrelation: 'Unknown correlation', internal: 'Internal error',
} as const
const refuse = (http: InboundResult['http'], error: string): InboundResult => ({ http, body: { error } })

/** `[...action]` segments to an accepted action; an optional leading `v1` is allowed (UNVERIFIED U7). */
export function actionFromPath(segments: string[]): AcceptedInboundAction | null {
  const parts = segments[0] === 'v1' ? segments.slice(1) : segments
  const path = parts.join('/')
  return (ACCEPTED_INBOUND_ACTIONS as readonly string[]).includes(path) ? (path as AcceptedInboundAction) : null
}

export interface InboundDeps {
  config: () => ConfigResult<NhcxConfig>
  now: () => Date
  rateLimit: (ip: string) => Promise<{ allowed: boolean }>
}
const defaultDeps = (): InboundDeps => ({ config: () => readNhcxConfig(), now: () => new Date(), rateLimit: checkNhcxCallbackRateLimit })

async function readCapped(request: Request, cap: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > cap) { await reader.cancel().catch(() => undefined); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
}

type Parsed =
  | { kind: 'eligibility'; summary: NhcxResponseSummary }
  | { kind: 'claim_response'; summary: NhcxResponseSummary }
  | { kind: 'communication'; summary: NhcxResponseSummary; basedOnIdentifier: string | null }
  | { kind: 'payment'; summary: NhcxResponseSummary }
  | { kind: 'status'; summary: NhcxResponseSummary }

export function parseInbound(action: AcceptedInboundAction, fhir: unknown, headers: ProtocolHeaders): Parsed | null {
  switch (action) {
    case 'coverageeligibility/on_check': { const r = parseEligibilityResponse(fhir); return r.ok ? { kind: 'eligibility', summary: r.summary } : null }
    case 'preauth/on_submit':
    case 'claim/on_submit': { const r = parseClaimResponseBundle(fhir); return r.ok ? { kind: 'claim_response', summary: r.summary } : null }
    case 'communication/request': { const r = parseCommunicationRequestTaskBundle(fhir); return r.ok ? { kind: 'communication', summary: r.summary, basedOnIdentifier: r.basedOnIdentifier } : null }
    case 'paymentnotice/request': { const r = parsePaymentNoticeTaskBundle(fhir); return r.ok ? { kind: 'payment', summary: r.summary } : null }
    case 'on_status': {
      const outcome = headers.status === 'response.complete' ? 'complete' : headers.status === 'response.partial' ? 'partial' : headers.status === 'response.error' ? 'error' : headers.status === 'request.queued' ? 'queued' : null
      return { kind: 'status', summary: { ...emptySummary(), outcome } }
    }
  }
}

/** The outbound exchange a callback answers: same correlation, sent by us to this sender. Falls back to the Claim identifier for insurer-initiated requests. */
async function findOutbound(action: AcceptedInboundAction, headers: ParsedHeaders, parsed: Parsed): Promise<NhcxExchangeRow | null> {
  const db = getDb()
  const [byCorrelation] = await db.select().from(nhcxExchanges)
    .where(and(eq(nhcxExchanges.correlationId, headers.correlationId), eq(nhcxExchanges.direction, 'outbound'), eq(nhcxExchanges.recipientCode, headers.sender)))
    .orderBy(desc(nhcxExchanges.id)).limit(1)
  if (byCorrelation) return byCorrelation
  if (action !== 'communication/request' && action !== 'paymentnotice/request') return null
  const ident = parsed.kind === 'communication' ? parsed.basedOnIdentifier : null
  if (!ident) return null
  const claimNumber = ident.replace(/\/v\d+$/, '')
  const [claim] = await db.select({ id: claims.id }).from(claims).where(eq(claims.claimNumber, claimNumber)).limit(1)
  const [pre] = claim ? [] : await db.select({ id: preauths.id }).from(preauths).where(eq(preauths.preauthNumber, ident)).limit(1)
  if (!claim && !pre) return null
  const [ex] = await db.select().from(nhcxExchanges)
    .where(and(claim ? eq(nhcxExchanges.claimId, claim.id) : eq(nhcxExchanges.preauthId, pre!.id), eq(nhcxExchanges.direction, 'outbound'), eq(nhcxExchanges.recipientCode, headers.sender)))
    .orderBy(desc(nhcxExchanges.id)).limit(1)
  return ex ?? null
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

const ENTITY: Record<AcceptedInboundAction, NhcxEntityType> = {
  'coverageeligibility/on_check': 'coverageeligibility', 'preauth/on_submit': 'preauth', 'claim/on_submit': 'claim',
  'communication/request': 'communication', 'paymentnotice/request': 'paymentnotice', on_status: 'status',
}
const NOTE: Partial<Record<AcceptedInboundAction, (s: NhcxResponseSummary) => string>> = {
  'claim/on_submit': (s) => `NHCX response received (${s.outcome ?? 'unknown'}); review it in the NHCX panel`,
  'communication/request': () => 'Insurer query received via NHCX; review it in the NHCX panel',
  'paymentnotice/request': () => 'Payment notice received via NHCX; record the settlement after checking the bank credit',
}

/** Stores one inbound message and its effects, inside the caller's transaction. A unique violation on api_call_id means a replay. */
export async function processInboundFhir(
  i: { action: AcceptedInboundAction; headers: ProtocolHeaders; fhir: unknown; outbound: NhcxExchangeRow; parsed: Parsed; isMock: boolean; now: Date },
  tx: Tx,
): Promise<{ exchangeId: number }> {
  const { action, headers, outbound, parsed, now } = i
  const json = JSON.stringify(i.fhir)
  const reviewState = action === 'preauth/on_submit' || action === 'claim/on_submit' || action === 'communication/request' || action === 'paymentnotice/request' ? 'pending' : 'not_needed'
  const [row] = await tx.insert(nhcxExchanges).values({
    entityType: ENTITY[action], direction: 'inbound', action, correlationId: headers.correlationId, apiCallId: headers.apiCallId,
    senderCode: headers.sender, recipientCode: headers.recipient, state: 'received', protocolStatus: headers.status, patientId: outbound.patientId,
    policyId: outbound.policyId, preauthId: outbound.preauthId, preauthEventId: outbound.preauthEventId, claimId: outbound.claimId,
    eligibilityCheckId: outbound.eligibilityCheckId, relatedExchangeId: outbound.id,
    bodySha256: createHash('sha256').update(json).digest('hex'),
    payloadEncrypted: action === 'on_status' ? null : sealPayload(json),
    summary: parsed.summary, reviewState, isMock: i.isMock, createdAt: now, updatedAt: now, respondedAt: now,
  }).returning({ id: nhcxExchanges.id })

  if (action === 'on_status') {
    const state = headers.status === 'request.queued' ? 'queued' : headers.status === 'request.dispatched' ? 'dispatched' : null
    await tx.update(nhcxExchanges).set({ protocolStatus: headers.status, ...(state && ['sent', 'queued', 'dispatched'].includes(outbound.state) ? { state } : {}), lastPolledAt: now, updatedAt: now })
      .where(eq(nhcxExchanges.id, outbound.id))
  } else if (action !== 'communication/request' && action !== 'paymentnotice/request') {
    // A late answer after no_response is still accepted (ruling 5).
    await tx.update(nhcxExchanges).set({ state: headers.status === 'response.error' ? 'error' : 'responded', protocolStatus: headers.status, respondedAt: now, updatedAt: now })
      .where(eq(nhcxExchanges.id, outbound.id))
  }
  if (action === 'coverageeligibility/on_check' && outbound.eligibilityCheckId) {
    const s = parsed.summary
    const status = s.outcome === 'error' || headers.status === 'response.error' ? 'error' : s.inforce === true ? 'eligible' : s.inforce === false ? 'not_eligible' : 'error'
    await tx.update(nhcxEligibilityChecks).set({ status, inforce: s.inforce, respondedAt: now }).where(eq(nhcxEligibilityChecks.id, outbound.eligibilityCheckId))
  }
  const note = NOTE[action]
  if (note && outbound.claimId) await addGatewayClaimNote(tx, outbound.claimId, note(parsed.summary), now)
  await logGatewayEvent('NHCX gateway', `nhcx: received ${action}`, outbound.patientId, `exchange=${row.id} related=${outbound.id} outcome=${parsed.summary.outcome ?? 'none'}`, tx)
  return { exchangeId: row.id }
}

export async function handleNhcxCallback(request: Request, actionPath: string, partial: Partial<InboundDeps> = {}): Promise<InboundResult> {
  const deps = { ...defaultDeps(), ...partial }
  const action = actionFromPath(actionPath.split('/').filter(Boolean))
  const log = (outcome: string, httpStatus: number) => safeLog('nhcx-callback', { action: action ?? 'unknown', outcome, httpStatus })
  if (!action) { log('unknown_action', 404); return refuse(404, FIXED.notFound) }

  const cfgResult = deps.config()
  if (cfgResult.state === 'not_configured') { log('not_configured', 503); return refuse(503, FIXED.notConfigured) }
  const cfg = cfgResult.state === 'configured' ? cfgResult.config : null

  const length = request.headers.get('content-length')
  if (length === null || !/^\d+$/.test(length) || Number(length) > MAX_CALLBACK_BYTES) { log('too_large', 413); return refuse(413, FIXED.tooLarge) }
  if (cfg && !checkCallerIp(request, cfg.callbackIpAllowlist)) { log('ip', 403); return refuse(403, FIXED.forbidden) }
  try {
    if (!(await deps.rateLimit(callerIp(request))).allowed) { log('rate', 429); return refuse(429, FIXED.tooMany) }
  } catch {
    log('rate_unavailable', 503); return refuse(503, FIXED.callbacksNotConfigured)
  }
  if (!cfg?.gatewaySigningCertPem) { log('no_signing_cert', 503); return refuse(503, FIXED.callbacksNotConfigured) }
  const now = deps.now()
  if (!(await verifyNhcxBearer(request, cfg.gatewaySigningCertPem, now))) { log('jwt', 401); return refuse(401, FIXED.unauthorized) }

  // Only now is the body read.
  const text = await readCapped(request, MAX_CALLBACK_BYTES)
  if (text === null) { log('too_large', 413); return refuse(413, FIXED.tooLarge) }
  let body: unknown
  try { body = JSON.parse(text) } catch { log('json', 400); return refuse(400, FIXED.invalid) }
  const payload = body && typeof body === 'object' ? (body as { payload?: unknown }).payload : undefined

  let fhir: unknown
  let rawHeaders: Record<string, unknown>
  if (typeof payload === 'string') {
    const opened = await openHcxPayload(payload, [cfg.encryptionPrivateKeyPem, ...(cfg.previousEncryptionPrivateKeyPem ? [cfg.previousEncryptionPrivateKeyPem] : [])])
    if (!opened.ok) { log(opened.problem, 400); return refuse(400, FIXED.invalid) }
    fhir = opened.fhir
    rawHeaders = opened.protectedHeader
  } else if (action === 'on_status' && body && typeof body === 'object' && (body as { type?: unknown }).type === 'ProtocolResponse') {
    // A plain-text ProtocolResponse (S3) carries the protocol headers in the body; on_status only.
    fhir = null
    rawHeaders = body as Record<string, unknown>
  } else {
    log('no_payload', 400); return refuse(400, FIXED.invalid)
  }

  const parsedHeaders = parseProtocolHeaders(rawHeaders)
  if (!parsedHeaders.ok) { log(parsedHeaders.problem, 400); return refuse(400, FIXED.invalid) }
  const headers = parsedHeaders.headers
  if (headers.recipient !== cfg.participantCode) { log('recipient', 403); return refuse(403, FIXED.forbidden) }
  if (!timestampWithin(headers.timestamp, now, 600)) { log('stale', 400); return refuse(400, FIXED.invalid) }
  const ok: InboundResult = { http: 202, body: { timestamp: istIsoWithOffset(now), api_call_id: headers.apiCallId, correlation_id: headers.correlationId } }

  const [seen] = await getDb().select({ id: nhcxInboundCalls.apiCallId }).from(nhcxInboundCalls).where(eq(nhcxInboundCalls.apiCallId, headers.apiCallId)).limit(1)
  if (seen) { log('replay', 202); return ok }

  const parsed = parseInbound(action, fhir, headers)
  if (!parsed) { log('unparsable', 400); return refuse(400, FIXED.invalid) }
  const outbound = await findOutbound(action, headers, parsed)
  if (!outbound) { log('unknown_correlation', 409); return refuse(409, FIXED.unknownCorrelation) }

  try {
    await getDb().transaction(async (tx) => {
      const { exchangeId } = await processInboundFhir({ action, headers, fhir, outbound, parsed, isMock: false, now }, tx)
      await tx.insert(nhcxInboundCalls).values({ apiCallId: headers.apiCallId, action, senderCode: headers.sender, correlationId: headers.correlationId, outcome: 'accepted', exchangeId, receivedAt: now })
    })
  } catch (e) {
    if (isUniqueViolation(e)) { log('replay', 202); return ok }
    log(e instanceof Error ? e.name : 'error', 500)
    return refuse(500, FIXED.internal)
  }
  log('accepted', 202)
  return ok
}

// ---- the labelled mock's synthesised answer (ruling 1) ------------------------------------

const MOCK_ANSWER: Partial<Record<string, AcceptedInboundAction>> = {
  'coverageeligibility/check': 'coverageeligibility/on_check', 'preauth/submit': 'preauth/on_submit', 'claim/submit': 'claim/on_submit',
}

/** Feeds a synthesised insurer answer for a mock row: eligibility in force, a queued pre-auth or claim. Never an approval amount. */
export async function synthesizeMockResponse(row: NhcxExchangeRow): Promise<void> {
  const action = MOCK_ANSWER[row.action]
  if (!action || !row.isMock) return
  const now = new Date()
  const headers: ProtocolHeaders = {
    sender: row.recipientCode, recipient: row.senderCode, apiCallId: randomUUID(), correlationId: row.correlationId, timestamp: istIsoWithOffset(now), status: 'response.complete',
  }
  const fhir = action === 'coverageeligibility/on_check'
    ? { resourceType: 'Bundle', type: 'collection', entry: [{ fullUrl: `urn:uuid:${randomUUID()}`, resource: { resourceType: 'CoverageEligibilityResponse', id: randomUUID(), outcome: 'complete', disposition: 'Sandbox mock - not real', insurance: [{ inforce: true }] } }] }
    : { resourceType: 'Bundle', type: 'collection', entry: [{ fullUrl: `urn:uuid:${randomUUID()}`, resource: { resourceType: 'ClaimResponse', id: randomUUID(), outcome: 'queued', use: action === 'preauth/on_submit' ? 'preauthorization' : 'claim', disposition: 'Sandbox mock - not real' } }] }
  const parsed = parseInbound(action, fhir, headers)
  if (!parsed) return
  await getDb().transaction(async (tx) => {
    const { exchangeId } = await processInboundFhir({ action, headers, fhir, outbound: row, parsed, isMock: true, now }, tx)
    await tx.insert(nhcxInboundCalls).values({ apiCallId: headers.apiCallId, action, senderCode: headers.sender, correlationId: headers.correlationId, outcome: 'accepted', exchangeId, receivedAt: now })
  })
}

