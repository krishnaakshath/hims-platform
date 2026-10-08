import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { and, eq } from 'drizzle-orm'

// SP5: the webhook records results through the lifecycle query (recordLabResult, LIS actor).
// The mocked cases fake it; the DB cases at the bottom set `useReal` and run the real query
// (and the real integration audit) against the test DB.
let useReal = false
const recordLabResult = vi.fn()
const logIntegrationEvent = vi.fn(async (...args: [string, string | null, string?, unknown?]) => { void args })
vi.mock('@/lib/queries/lab-lifecycle', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/lab-lifecycle')>('@/lib/queries/lab-lifecycle')
  return { ...actual, recordLabResult: (...a: Parameters<typeof actual.recordLabResult>) => (useReal ? actual.recordLabResult(...a) : recordLabResult(...a)) }
})
vi.mock('@/lib/patient-portal-audit', async () => {
  const actual = await vi.importActual<typeof import('@/lib/patient-portal-audit')>('@/lib/patient-portal-audit')
  return {
    ...actual,
    logIntegrationEvent: (...a: Parameters<typeof actual.logIntegrationEvent>) => (useReal ? actual.logIntegrationEvent(...a) : logIntegrationEvent(...(a as [string, string | null, string?, unknown?]))),
  }
})

import { getDb } from '@/db/client'
import { auditLog, labOrders, labResults, labTests, patients, providers } from '@/db/schema'
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

// Mock of the real recordLabResult's transactional contract: the integration audit runs inside
// the (fake) transaction; it commits only if the audit resolves.
const FAKE_TX = { tx: true }
let commits = 0
function useCommittingEnterResult(patientId: string) {
  recordLabResult.mockImplementation(async (id: number) => {
    await logIntegrationEvent(`accepted LIS lab result for order ${id}`, patientId, undefined, FAKE_TX)
    commits++
    return { ok: true, patientId, amended: false }
  })
}

let saved: string | undefined
let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  saved = process.env.LIS_INTEGRATION_TOKEN
  recordLabResult.mockReset()
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
  it('returns 503 JSON and never calls recordLabResult when LIS_INTEGRATION_TOKEN is unset', async () => {
    delete process.env.LIS_INTEGRATION_TOKEN
    for (const auth of [undefined, 'Bearer test-hl7-token']) {
      const res = await call(auth)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'LIS integration is not configured' })
    }
    expect(recordLabResult).not.toHaveBeenCalled()
    expect(logIntegrationEvent).not.toHaveBeenCalled()
  })

  it('returns 401 for a missing or wrong token, writes no audit row and logs no token material', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    for (const auth of [undefined, 'Bearer wrong-token', 'Basic ' + TOKEN]) {
      expect((await call(auth)).status).toBe(401)
    }
    expect(recordLabResult).not.toHaveBeenCalled()
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
    expect(recordLabResult).not.toHaveBeenCalled()
    expect(logIntegrationEvent).not.toHaveBeenCalled()
  })

  it('accepts the correct token, enters the result and records an accepted event with the patient id', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    useCommittingEnterResult('RD-T')
    const res = await call(`Bearer ${TOKEN}`)
    expect(res.status).toBe(200)
    expect(recordLabResult).toHaveBeenCalledTimes(1)
    expect(recordLabResult.mock.calls[0][0]).toBe(7)
    expect(recordLabResult.mock.calls[0][2]).toEqual({ kind: 'lis' })
    expect(recordLabResult.mock.calls[0][3]).toMatchObject({ expectedPatientId: 'RD-T' })
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
      expect(recordLabResult).not.toHaveBeenCalled()
    })

  it('returns 400 for a non-JSON body with a valid token, but 401 first with a wrong token', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    const raw = (auth: string) => POST(new Request('http://localhost/api/webhooks/fhir-labs', { method: 'POST', headers: { authorization: auth }, body: 'not json' }) as never)
    const ok = await raw(`Bearer ${TOKEN}`)
    expect(ok.status).toBe(400)
    expect(await ok.json()).toEqual({ error: 'Invalid JSON' })
    expect((await raw('Bearer nope')).status).toBe(401)
    expect(recordLabResult).not.toHaveBeenCalled()
  })

  it('rejects a subject that is not Patient/<id> with 400', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    const res = await call(`Bearer ${TOKEN}`, { ...body, subject: { reference: 'Group/RD-T' } })
    expect(res.status).toBe(400)
    expect(recordLabResult).not.toHaveBeenCalled()
  })

  it('returns a generic 409 and writes no audit when the order belongs to another patient / is not collected', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    recordLabResult.mockResolvedValue({ ok: false, error: 'patient_mismatch' })
    const res = await call(`Bearer ${TOKEN}`, { ...body, subject: { reference: 'Patient/RD-OTHER' } })
    expect(res.status).toBe(409)
    expect(recordLabResult.mock.calls[0][3]).toMatchObject({ expectedPatientId: 'RD-OTHER' })
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
    expect(recordLabResult).not.toHaveBeenCalled()
    expect(logIntegrationEvent).not.toHaveBeenCalled()
  })
})

// SP5 Task 8: Observation statuses and the lifecycle.
describe('POST /api/webhooks/fhir-labs — Observation status', () => {
  it.each(['entered-in-error', 'registered', 'cancelled', 'unknown'])('400s a %s observation before any write', async (status) => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    const res = await call(`Bearer ${TOKEN}`, { ...body, status })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Unsupported Observation status' })
    expect(recordLabResult).not.toHaveBeenCalled()
  })

  it.each(['preliminary', 'final', 'amended', 'corrected'])('accepts a %s observation', async (status) => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    useCommittingEnterResult('RD-T')
    expect((await call(`Bearer ${TOKEN}`, { ...body, status })).status).toBe(200)
  })

  it('a deadlock is a 409 asking the LIS to retry', async () => {
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
    recordLabResult.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
    const res = await call(`Bearer ${TOKEN}`)
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/try again/)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('POST /api/webhooks/fhir-labs — lifecycle (DB)', () => {
  const RUN = `${Date.now()}`
  const PATIENT = `TEST-SP5-${RUN}-WH`
  const orderIds: number[] = []
  let labTestId = 0
  let providerId = 0

  async function order(status: 'collected' | 'verified') {
    const [o] = await getDb().insert(labOrders).values({
      patientId: PATIENT, labTestId, orderedByProviderId: providerId, status, collectedAt: new Date(),
      ...(status === 'verified' ? { receivedAt: new Date(), verifiedAt: new Date(), verifiedByName: 'TEST_SP5 verifier' } : {}),
    }).returning()
    orderIds.push(o.id)
    if (status === 'verified') await getDb().insert(labResults).values({ labOrderId: o.id, value: '1.0', flag: 'normal', resultedByName: 'TEST_SP5 lab' })
    return o
  }
  const obs = (orderId: number, over: Record<string, unknown> = {}) => ({
    ...body, subject: { reference: `Patient/${PATIENT}` }, basedOn: [{ reference: `ServiceRequest/${orderId}` }], valueQuantity: { value: 7.5, unit: 'mmol/L' }, valueString: undefined, ...over,
  })
  async function state(id: number) {
    const [o] = await getDb().select().from(labOrders).where(eq(labOrders.id, id))
    const results = await getDb().select().from(labResults).where(eq(labResults.labOrderId, id))
    return { o, results }
  }

  beforeAll(async () => {
    await getDb().insert(patients).values({ id: PATIENT, name: 'TEST_SP5 webhook', dob: '1980-01-01' })
    ;[{ id: labTestId }] = await getDb().select({ id: labTests.id }).from(labTests).limit(1)
    ;[{ id: providerId }] = await getDb().select({ id: providers.id }).from(providers).limit(1)
  })
  beforeEach(() => {
    useReal = true
    process.env.LIS_INTEGRATION_TOKEN = TOKEN
  })
  afterEach(() => {
    useReal = false
  })
  afterAll(async () => {
    for (const id of orderIds) {
      await getDb().delete(labResults).where(eq(labResults.labOrderId, id))
      await getDb().delete(labOrders).where(eq(labOrders.id, id))
    }
    await getDb().delete(auditLog).where(and(eq(auditLog.userName, 'LIS integration'), eq(auditLog.patientId, PATIENT)))
    await getDb().delete(patients).where(eq(patients.id, PATIENT))
  })

  it('a final observation lands as resulted (awaiting verification), not verified', async () => {
    const o = await order('collected')
    const res = await call(`Bearer ${TOKEN}`, obs(o.id, { status: 'final' }))
    expect(res.status).toBe(200)
    const { o: after, results } = await state(o.id)
    expect(after.status).toBe('resulted')
    expect(after.verifiedAt).toBeNull()
    expect(after.receivedByName).toBe('System (LIS API)')
    expect(results.map((r) => [r.value, r.unit, r.resultedByName, r.resultedByUserId])).toEqual([['7.5', 'mmol/L', 'System (LIS API)', null]])
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.userName, 'LIS integration'), eq(auditLog.patientId, PATIENT), eq(auditLog.action, `accepted LIS lab result for order ${o.id}`)))
    expect(audits).toHaveLength(1)
  })

  it('rejects an entered-in-error observation with 400 and writes nothing', async () => {
    const o = await order('collected')
    const res = await call(`Bearer ${TOKEN}`, obs(o.id, { status: 'entered-in-error' }))
    expect(res.status).toBe(400)
    const { o: after, results } = await state(o.id)
    expect([after.status, after.receivedAt, results.length]).toEqual(['collected', null, 0])
  })

  it('409s a result for an already verified order', async () => {
    const o = await order('verified')
    const res = await call(`Bearer ${TOKEN}`, obs(o.id, { status: 'corrected' }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'Order not found, not awaiting a result, or does not belong to this patient' })
    const { o: after, results } = await state(o.id)
    expect(after.status).toBe('verified')
    expect(results.map((r) => r.value)).toEqual(['1.0'])
  })
})
