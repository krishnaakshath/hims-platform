// SP6 Task 14: GET/PUT /api/coding/services/[serviceId]/procedure-codes. The query module is mocked
// (its DB behaviour is tests/lib/queries/service-procedure-codes.test.ts); the zod schema is real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role | null = 'coder'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return {
    ...actual,
    requireSession: vi.fn(async () =>
      sessionRole === null ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) : { role: sessionRole, name: 'Probe', userId: 9 }),
  }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/service-procedure-codes', () => ({ listServiceProcedureCodes: vi.fn(), replaceServiceProcedureCodes: vi.fn() }))

import { listServiceProcedureCodes, replaceServiceProcedureCodes } from '@/lib/queries/service-procedure-codes'
import { GET, PUT } from '@/app/api/coding/services/[serviceId]/procedure-codes/route'

const path = (id: string) => `http://localhost/api/coding/services/${id}/procedure-codes`
const get = (id = '5') => GET(new NextRequest(path(id)), { params: Promise.resolve({ serviceId: id }) })
const put = (body: unknown, id = '5') =>
  PUT(new NextRequest(path(id), { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ serviceId: id }) })
const ROW = { serviceId: 5, kind: 'hbp', code: 'SMP001A', isPrimary: true, display: 'SAMPLE fictional', isSample: true }
const BODY = { codes: [{ kind: 'hbp', code: 'SMP001A', isPrimary: true }] }

beforeEach(() => {
  sessionRole = 'coder'
  vi.mocked(listServiceProcedureCodes).mockReset().mockResolvedValue(new Map([[5, [ROW as never]]]))
  vi.mocked(replaceServiceProcedureCodes).mockReset().mockResolvedValue({ ok: true })
})

describe('GET /api/coding/services/[serviceId]/procedure-codes', () => {
  it('401s without a session; 403s roles outside CODE_LOOKUP_ROLES', async () => {
    sessionRole = null
    expect((await get()).status).toBe(401)
    for (const role of ['frontdesk', 'pharmacy', 'labs'] as Role[]) {
      sessionRole = role
      const res = await get()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(listServiceProcedureCodes).not.toHaveBeenCalled()
  })

  it('returns the mapped codes for lookup roles (billing included), [] when unmapped', async () => {
    for (const role of ['admin', 'coder', 'pi', 'crc', 'billing', 'rcm'] as Role[]) { // SP7: + rcm
      sessionRole = role
      const res = await get()
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ codes: [ROW] })
    }
    expect(listServiceProcedureCodes).toHaveBeenCalledWith([5])
    vi.mocked(listServiceProcedureCodes).mockResolvedValue(new Map())
    expect(await (await get()).json()).toEqual({ codes: [] })
  })

  it('400s a bad id without querying', async () => {
    const res = await get('abc')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid service id' })
    expect(listServiceProcedureCodes).not.toHaveBeenCalled()
  })
})

describe('PUT /api/coding/services/[serviceId]/procedure-codes', () => {
  it('403s every role outside CODING_ROLES before reading the body', async () => {
    for (const role of ['pi', 'crc', 'billing', 'frontdesk', 'pharmacy', 'labs', 'rcm'] as Role[]) {
      sessionRole = role
      const res = await put('{not json')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
    expect(replaceServiceProcedureCodes).not.toHaveBeenCalled()
  })

  it('replaces the map for coder and admin', async () => {
    for (const role of ['coder', 'admin'] as Role[]) {
      sessionRole = role
      const res = await put(BODY)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
    expect(replaceServiceProcedureCodes).toHaveBeenCalledWith(5, BODY.codes, expect.objectContaining({ role: 'admin' }))
  })

  it('400s bad JSON, a bad id, unknown keys (not echoed), two primaries and duplicates', async () => {
    expect(await (await put('{not json')).json()).toEqual({ error: 'Invalid JSON' })
    expect((await put(BODY, '0')).status).toBe(400)
    const unknown = await put({ codes: [], secretKeyXYZ: 1 })
    expect(unknown.status).toBe(400)
    expect(JSON.stringify(await unknown.json())).not.toContain('secretKeyXYZ')
    const two = await put({ codes: [{ kind: 'hbp', code: 'A1', isPrimary: true }, { kind: 'hbp', code: 'A2', isPrimary: true }] })
    expect(await two.json()).toEqual({ error: 'Only one code can be primary' })
    const dup = await put({ codes: [{ kind: 'hbp', code: 'A1', isPrimary: false }, { kind: 'hbp', code: 'A1', isPrimary: false }] })
    expect(await dup.json()).toEqual({ error: 'Each code can be mapped once' })
    expect(replaceServiceProcedureCodes).not.toHaveBeenCalled()
  })

  it('maps refusals: 404 unknown service, 400 with problems for incompatible or unknown codes', async () => {
    vi.mocked(replaceServiceProcedureCodes).mockResolvedValueOnce({ ok: false, error: 'service_not_found' })
    const nf = await put(BODY)
    expect(nf.status).toBe(404)
    expect(await nf.json()).toEqual({ error: 'Service not found' })

    vi.mocked(replaceServiceProcedureCodes).mockResolvedValueOnce({ ok: false, error: 'incompatible', problems: ['ICD-10-PCS codes do not fit a package service'] })
    const inc = await put(BODY)
    expect(inc.status).toBe(400)
    expect(await inc.json()).toEqual({ error: 'These codes do not fit this service', problems: ['ICD-10-PCS codes do not fit a package service'] })

    vi.mocked(replaceServiceProcedureCodes).mockResolvedValueOnce({ ok: false, error: 'code_not_found', problems: ['SMP999Z is not an active PM-JAY HBP package code in the current version'] })
    const cnf = await put(BODY)
    expect(cnf.status).toBe(400)
    expect(await cnf.json()).toEqual({ error: 'Some codes are not in the current code set', problems: ['SMP999Z is not an active PM-JAY HBP package code in the current version'] })
  })

  it('409s a deadlock with the retry message and 500s other errors without the pg message', async () => {
    vi.mocked(replaceServiceProcedureCodes).mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
    const dl = await put(BODY)
    expect(dl.status).toBe(409)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(replaceServiceProcedureCodes).mockRejectedValueOnce(Object.assign(new Error('value SMP001A leaked'), { code: '23505', constraint: 'service_procedure_codes_unique' }))
    const boom = await put(BODY)
    expect(boom.status).toBe(500)
    expect(JSON.stringify(await boom.json())).not.toContain('leaked')
    expect(err.mock.calls.flat().join(' ')).not.toContain('leaked')
    err.mockRestore()
  })
})
