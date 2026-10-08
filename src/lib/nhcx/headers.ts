import { randomUUID } from 'node:crypto'
import { HCX_HEADER, HCX_STATUS_VALUES, NHCX_SEND_WORKFLOW_ID, type HcxStatus } from './constants'

// HCX protocol headers (S4 v0.8, carried in the JWE protected header). Pure
// apart from randomUUID. Timestamps are IST with an explicit offset.

export interface ProtocolHeaders {
  sender: string
  recipient: string
  apiCallId: string
  correlationId: string
  timestamp: string
  status: HcxStatus
  abhaId?: string
  workflowId?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ABHA_DASHED = /^\d{2}-\d{4}-\d{4}-\d{4}$/
const IST_OFFSET_MS = 330 * 60 * 1000

/** e.g. 2026-10-08T11:32:26.605+05:30 */
export function istIsoWithOffset(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().replace(/Z$/, '+05:30')
}

export function buildRequestHeaders(i: {
  sender: string
  recipient: string
  apiCallId?: string
  correlationId?: string
  abhaId?: string | null
  now: Date
  status?: HcxStatus
}): ProtocolHeaders {
  const h: ProtocolHeaders = {
    sender: i.sender,
    recipient: i.recipient,
    apiCallId: i.apiCallId ?? randomUUID(),
    correlationId: i.correlationId ?? randomUUID(),
    timestamp: istIsoWithOffset(i.now),
    status: i.status ?? 'request.initiated',
  }
  if (i.abhaId && ABHA_DASHED.test(i.abhaId)) h.abhaId = i.abhaId
  // workflowId is never set while NHCX_SEND_WORKFLOW_ID is false (U5).
  return h
}

export function toJoseHeader(h: ProtocolHeaders): Record<string, string> {
  const out: Record<string, string> = {
    [HCX_HEADER.sender]: h.sender,
    [HCX_HEADER.recipient]: h.recipient,
    [HCX_HEADER.apiCallId]: h.apiCallId,
    [HCX_HEADER.correlationId]: h.correlationId,
    [HCX_HEADER.timestamp]: h.timestamp,
    [HCX_HEADER.status]: h.status,
  }
  if (h.abhaId) out[HCX_HEADER.abhaId] = h.abhaId
  if (h.workflowId && NHCX_SEND_WORKFLOW_ID) out[HCX_HEADER.workflowId] = h.workflowId
  return out
}

export type ParsedHeaders = ProtocolHeaders & { errorDetails?: { code: string; message: string } }
export type HeaderProblem = 'missing_header' | 'bad_uuid' | 'bad_timestamp' | 'bad_status'

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/
const PARTY = /^[A-Za-z0-9@._-]{1,100}$/

export function parseProtocolHeaders(raw: Record<string, unknown>): { ok: true; headers: ParsedHeaders } | { ok: false; problem: HeaderProblem } {
  const get = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string) : null)
  const sender = get(HCX_HEADER.sender)
  const recipient = get(HCX_HEADER.recipient)
  const apiCallId = get(HCX_HEADER.apiCallId)
  const correlationId = get(HCX_HEADER.correlationId)
  const timestamp = get(HCX_HEADER.timestamp)
  const status = get(HCX_HEADER.status)
  if (!sender || !recipient || !apiCallId || !correlationId || !timestamp || !status) return { ok: false, problem: 'missing_header' }
  if (!PARTY.test(sender) || !PARTY.test(recipient)) return { ok: false, problem: 'missing_header' }
  if (!UUID.test(apiCallId) || !UUID.test(correlationId)) return { ok: false, problem: 'bad_uuid' }
  if (!TIMESTAMP.test(timestamp) || Number.isNaN(Date.parse(timestamp))) return { ok: false, problem: 'bad_timestamp' }
  if (!(HCX_STATUS_VALUES as readonly string[]).includes(status)) return { ok: false, problem: 'bad_status' }
  const headers: ParsedHeaders = { sender, recipient, apiCallId: apiCallId.toLowerCase(), correlationId: correlationId.toLowerCase(), timestamp, status: status as HcxStatus }
  const abha = get(HCX_HEADER.abhaId)
  if (abha && ABHA_DASHED.test(abha)) headers.abhaId = abha
  const wf = get(HCX_HEADER.workflowId)
  if (wf && wf.length <= 64) headers.workflowId = wf
  const err = raw[HCX_HEADER.errorDetails]
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown }
    if (typeof e.code === 'string') headers.errorDetails = { code: e.code.slice(0, 64), message: typeof e.message === 'string' ? e.message.slice(0, 500) : '' }
  }
  return { ok: true, headers }
}

/** Whether a protocol timestamp is within `toleranceSeconds` of now (either direction). */
export function timestampWithin(ts: string, now: Date, toleranceSeconds = 600): boolean {
  const t = Date.parse(ts)
  return Number.isFinite(t) && Math.abs(now.getTime() - t) <= toleranceSeconds * 1000
}
