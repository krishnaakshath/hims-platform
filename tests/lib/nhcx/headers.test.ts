import { describe, it, expect } from 'vitest'
import { buildRequestHeaders, istIsoWithOffset, parseProtocolHeaders, timestampWithin, toJoseHeader } from '@/lib/nhcx/headers'
import { ACCEPTED_INBOUND_ACTIONS, NHCX_ACTIONS } from '@/lib/nhcx/constants'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const C = '6d8f9a3e-1b2c-4d5e-8f90-123456789abc'
const BASE = { sender: 'P1@sbx', recipient: 'TPA1@sbx', now: new Date('2026-10-08T06:02:26.605Z') }
const VALID = {
  'x-hcx-sender_code': 'TPA1@sbx', 'x-hcx-recipient_code': 'P1@sbx', 'x-hcx-api_call_id': '0b6c7c5e-6d3f-4d4c-9a51-2f7d4f0d9f11',
  'x-hcx-correlation_id': C, 'x-hcx-timestamp': '2026-10-08T11:32:26.605+05:30', 'x-hcx-status': 'response.complete',
}

describe('HCX protocol headers', () => {
  it('builds request headers with fresh ids, IST timestamp and no workflow id', () => {
    const h = buildRequestHeaders(BASE)
    expect(h.timestamp).toBe('2026-10-08T11:32:26.605+05:30'); expect(h.apiCallId).toMatch(UUID); expect(h.status).toBe('request.initiated')
    expect(toJoseHeader(h)).not.toHaveProperty('x-hcx-workflow_id'); expect(toJoseHeader(h)['x-hcx-recipient_code']).toBe('TPA1@sbx')
    expect(buildRequestHeaders(BASE).apiCallId).not.toBe(h.apiCallId)
  })
  it('keeps a given correlation id and api call id', () => {
    const h = buildRequestHeaders({ ...BASE, correlationId: C, apiCallId: VALID['x-hcx-api_call_id'] })
    expect(h.correlationId).toBe(C); expect(h.apiCallId).toBe(VALID['x-hcx-api_call_id'])
  })
  it('sends the ABHA header only when dashed', () => {
    expect(toJoseHeader(buildRequestHeaders({ ...BASE, abhaId: '91-1234-5678-9012' }))['x-hcx-ben-abha-id']).toBe('91-1234-5678-9012')
    expect(toJoseHeader(buildRequestHeaders({ ...BASE, abhaId: '91123456789012' }))).not.toHaveProperty('x-hcx-ben-abha-id')
    expect(toJoseHeader(buildRequestHeaders({ ...BASE, abhaId: null }))).not.toHaveProperty('x-hcx-ben-abha-id')
  })
  it('formats IST across midnight', () => {
    expect(istIsoWithOffset(new Date('2026-10-08T18:45:00.000Z'))).toBe('2026-10-09T00:15:00.000+05:30')
  })
  it('parses and rejects protocol headers', () => {
    expect(parseProtocolHeaders(VALID)).toMatchObject({ ok: true, headers: { sender: 'TPA1@sbx', correlationId: C, status: 'response.complete' } })
    expect(parseProtocolHeaders({ ...VALID, 'x-hcx-api_call_id': 'nope' })).toEqual({ ok: false, problem: 'bad_uuid' })
    expect(parseProtocolHeaders({ ...VALID, 'x-hcx-status': 'done' })).toEqual({ ok: false, problem: 'bad_status' })
    expect(parseProtocolHeaders({ ...VALID, 'x-hcx-timestamp': 'yesterday' })).toEqual({ ok: false, problem: 'bad_timestamp' })
    const { ['x-hcx-sender_code']: _drop, ...noSender } = VALID
    void _drop
    expect(parseProtocolHeaders(noSender)).toEqual({ ok: false, problem: 'missing_header' })
  })
  it('carries error details', () => {
    const r = parseProtocolHeaders({ ...VALID, 'x-hcx-status': 'response.error', 'x-hcx-error_details': { code: 'ERR_INVALID_PAYLOAD', message: 'bad' } })
    expect(r).toMatchObject({ ok: true, headers: { errorDetails: { code: 'ERR_INVALID_PAYLOAD', message: 'bad' } } })
  })
  it('checks timestamp tolerance', () => {
    const now = new Date('2026-10-08T06:02:26.605Z')
    expect(timestampWithin('2026-10-08T11:32:26.605+05:30', now)).toBe(true)
    expect(timestampWithin('2026-10-08T11:45:00.000+05:30', now)).toBe(false)
    expect(timestampWithin('garbage', now)).toBe(false)
  })
  it('a provider accepts only callbacks and insurer-initiated requests', () => {
    for (const a of ACCEPTED_INBOUND_ACTIONS) expect(NHCX_ACTIONS[a]).toBeDefined()
    expect(ACCEPTED_INBOUND_ACTIONS).not.toContain('claim/submit')
    expect(ACCEPTED_INBOUND_ACTIONS).not.toContain('coverageeligibility/check')
    expect(Object.keys(NHCX_ACTIONS).some((k) => k.includes('predetermination'))).toBe(false)
  })
})
