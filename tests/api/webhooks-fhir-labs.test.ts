import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const enterResult = vi.fn()
const logIntegrationEvent = vi.fn(async (...args: [string, string | null, string?, unknown?]) => { void args })
vi.mock('@/lib/queries/lab-orders', () => ({ enterResult: (...a: unknown[]) => enterResult(...a) }))
vi.mock('@/lib/patient-portal-audit', () => ({ logIntegrationEvent: (...a: [string, string | null, string?, unknown?]) => logIntegrationEvent(...a) }))

import { POST } from '@/app/api/webhooks/fhir-labs/route'

const TOKEN = 'lis-test-secret-value'
const body = {
  resourceType: 'Observation', status: 'final',
  code: { coding: [{ code: '1234-5' }] },
  subject: { reference: 'Patient/RD-T' },
  valueString: 'ok',
  basedOn: [{ reference: 'ServiceRequest/7' }],
}
const call = (auth?: string, payload: unknown = body) =>
  POST(new Request('http://localhost/api/webhooks/fhir-labs', {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
    body: JSON.stringify(payload),
  }) as never)

// Mock of the real enterResult's transactional contract: run the audit hook
// inside a fake transaction; commit only if the hook resolves.
const FAKE_TX = { tx: true }
let commits = 0
function useCommittingEnterResult(patientId: string) {
  enterResult.mockImplementation(async (_id: number, _input: unknown, opts?: { afterEntered?: (tx: unknown, pid: string) => Promise<void> }) => {
    await opts?.afterEntered?.(FAKE_TX, patientId)
    commits++
    return { ok: true, patientId }
  })
}

let saved: string | undefined
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  saved = process.env.LIS_INTEGRATION_TOKEN
  enterResult.mockReset()
  commits = 0
  logIntegrationEvent.mockClear()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  if (saved === undefined) delete process.env.LIS_INTEGRATION_TOKEN
  else process.env.LIS_INTEGRATION_TOKEN = saved
  warn.mockRestore()
})

describe('POST /api/webhooks/fhir-labs', () => {
  it('returns 503 JSON and never calls enterResult when LIS_INTEGRATION_TOKEN is unset', async () => {
    delete process.env.LIS_INTEGRATION_TOKEN
    for (const auth of [undefined, 'Bearer test-hl7-token']) {
      const res = await call(auth)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'LIS integration is not configured' })
    }
    expect(enterResult).not.toHaveBeenCalled()
    expect(logIntegrationEvent).not.toHaveBeenCalled()
  })

  it('returns 401 for a missing or wrong token, writes no audit row and logs no token material', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    for (const auth of [undefined, 'Bearer wrong-token', 'Basic ' + TOKEN]) {
      expect((await call(auth)).status).toBe(401)
    }
    expect(enterResult).not.toHaveBeenCalled()
    expect(logIntegrationEvent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('wrong-token')
  })

  it('rejects a token that differs only in length', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    expect((await call(`Bearer ${TOKEN}x`)).status).toBe(401)
    expect((await call(`Bearer ${TOKEN.slice(0, -1)}`)).status).toBe(401)
    expect(enterResult).not.toHaveBeenCalled()
    expect(logIntegrationEvent).not.toHaveBeenCalled()
  })

  it('accepts the correct token, enters the result and records an accepted event with the patient id', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    useCommittingEnterResult('RD-T')
    const res = await call(`Bearer ${TOKEN}`)
    expect(res.status).toBe(200)
    expect(enterResult).toHaveBeenCalledTimes(1)
    expect(enterResult.mock.calls[0][0]).toBe(7)
    expect(enterResult.mock.calls[0][2]).toMatchObject({ expectedPatientId: 'RD-T' })
    expect(logIntegrationEvent).toHaveBeenCalledWith('accepted LIS lab result for order 7', 'RD-T', undefined, FAKE_TX)
    expect(commits).toBe(1)
  })

  it('trims the env token: whitespace-only -> 503; trailing newline still matches', async () => {
    process.env.LIS_INTEGRATION_TOKEN = '  \n'
    expect((await call(`Bearer anything`)).status).toBe(503)
    process.env.LIS_INTEGRATION_TOKEN = TOKEN + '\n'
    useCommittingEnterResult('RD-T')
    expect((await call(`Bearer ${TOKEN}`)).status).toBe(200)
  })

  it('parses the Bearer scheme case-insensitively; empty bearer -> 401', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    useCommittingEnterResult('RD-T')
    expect((await call(`bearer ${TOKEN}`)).status).toBe(200)
    expect((await call('Bearer ')).status).toBe(401)
    expect((await call('Bearer')).status).toBe(401)
  })

  it.each(['ServiceRequest/abc', 'ServiceRequest/7abc', 'ServiceRequest/0', 'ServiceRequest/99999999999', 'ServiceRequest/2147483648', 'ServiceRequest/-1', 'ServiceRequest/'])(
    'rejects malformed order reference %s with 400 and no write', async (ref) => {
      process.env.LIS_INTEGRATION_TOKEN = TOKEN
      const res = await call(`Bearer ${TOKEN}`, { ...body, basedOn: [{ reference: ref }] })
      expect(res.status).toBe(400)
      expect(enterResult).not.toHaveBeenCalled()
    })

  it('returns 400 for a non-JSON body with a valid token, but 401 first with a wrong token', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    const raw = (auth: string) => POST(new Request('http://localhost/api/webhooks/fhir-labs', { method: 'POST', headers: { authorization: auth }, body: 'not json' }) as never)
    const ok = await raw(`Bearer ${TOKEN}`)
    expect(ok.status).toBe(400)
    expect(await ok.json()).toEqual({ error: 'Invalid JSON' })
    expect((await raw('Bearer nope')).status).toBe(401)
    expect(enterResult).not.toHaveBeenCalled()
  })

  it('rejects a subject that is not Patient/<id> with 400', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    const res = await call(`Bearer ${TOKEN}`, { ...body, subject: { reference: 'Group/RD-T' } })
    expect(res.status).toBe(400)
    expect(enterResult).not.toHaveBeenCalled()
  })

  it('returns a generic 409 and writes no audit when the order belongs to another patient / is not collected', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    enterResult.mockResolvedValue({ ok: false, error: 'Order is not in collected status for this patient' })
    const res = await call(`Bearer ${TOKEN}`, { ...body, subject: { reference: 'Patient/RD-OTHER' } })
    expect(res.status).toBe(409)
    expect(enterResult.mock.calls[0][2]).toMatchObject({ expectedPatientId: 'RD-OTHER' })
    expect(logIntegrationEvent).not.toHaveBeenCalled()
    expect(JSON.stringify(await res.json())).not.toContain('RD-')
  })

  it('returns 500 and commits nothing when the audit step throws (rollback), logging only the message', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    useCommittingEnterResult('RD-T')
    logIntegrationEvent.mockRejectedValueOnce(new Error('audit down'))
    const res = await call(`Bearer ${TOKEN}`)
    expect(res.status).toBe(500)
    expect(commits).toBe(0)
    expect(JSON.stringify(err.mock.calls)).toContain('audit down')
    expect(JSON.stringify(err.mock.calls)).not.toContain(TOKEN)
    err.mockRestore()
  })

  it('returns 400 for an invalid payload with a valid token and enters nothing', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    const res = await call(`Bearer ${TOKEN}`, {})
    expect(res.status).toBe(400)
    expect(enterResult).not.toHaveBeenCalled()
    expect(logIntegrationEvent).not.toHaveBeenCalled()
  })
})
