// SP6 Task 6: code-system import / list / set-current routes and the code search API. The query
// layer is mocked (its DB behaviour is tests/lib/queries/code-systems.test.ts); the validator is real.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'
import { WEB_IMPORT_LIMITS } from '@/lib/coding/import'

let sessionRole: Role | null = 'admin'
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return {
    ...actual,
    requireSession: vi.fn(async () =>
      sessionRole === null ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) : { role: sessionRole, name: 'Probe', userId: 9 }),
  }
})
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/code-systems', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/code-systems')>('@/lib/queries/code-systems')
  return {
    ...actual,
    commitCodeSystemImport: vi.fn(), listCodeSystems: vi.fn(), setCurrentCodeSystem: vi.fn(), searchCodes: vi.fn(),
  }
})

import {
  CodeSystemVersionExistsError, SampleOverLicensedError, commitCodeSystemImport, listCodeSystems, searchCodes,
  setCurrentCodeSystem, sha256Hex,
} from '@/lib/queries/code-systems'
import { POST } from '@/app/api/coding/code-systems/import/route'
import { GET as GET_LIST } from '@/app/api/coding/code-systems/route'
import { PATCH } from '@/app/api/coding/code-systems/[id]/route'
import { GET as GET_CODES } from '@/app/api/coding/codes/route'

const SAMPLE = readFileSync('scripts/code-systems/samples/SAMPLE-icd10.csv', 'utf8')
const BODY = {
  kind: 'icd10', version: 'SAMPLE-ICD10-0', name: 'Sample ICD-10', licenceNote: null,
  sourceFileName: 'SAMPLE-icd10.csv', csv: SAMPLE, commit: false, makeCurrent: false,
}
const jsonReq = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  new NextRequest('http://localhost/api/coding/code-systems/import', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
const get = (path: string) => new NextRequest(`http://localhost${path}`)
const patch = (body: unknown) =>
  new NextRequest('http://localhost/api/coding/code-systems/5', { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) })
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  sessionRole = 'admin'
  vi.mocked(commitCodeSystemImport).mockReset().mockResolvedValue({ codeSystemId: 11, codeCount: 8, isCurrent: true })
  vi.mocked(listCodeSystems).mockReset().mockResolvedValue([])
  vi.mocked(setCurrentCodeSystem).mockReset().mockResolvedValue('ok')
  vi.mocked(searchCodes).mockReset().mockResolvedValue({ codeSystem: { id: 1, version: 'V', isSample: false }, hits: [] })
})

describe('POST /api/coding/code-systems/import', () => {
  it('401s without a session and 403s every role but admin before reading the body', async () => {
    sessionRole = null
    expect((await POST(jsonReq(BODY))).status).toBe(401)
    for (const role of ['coder', 'pi', 'crc', 'billing', 'frontdesk', 'pharmacy', 'labs'] as Role[]) {
      sessionRole = role
      const res = await POST(jsonReq('{not json'))
      expect(res.status, role).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
  })

  it('415s anything but application/json', async () => {
    expect((await POST(jsonReq(BODY, { 'content-type': 'text/csv' }))).status).toBe(415)
  })

  it('413s an oversize CSV and names the CLI', async () => {
    const res = await POST(jsonReq({ ...BODY, csv: 'x'.repeat(WEB_IMPORT_LIMITS.maxBytes + 1) }))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/codes:import/)
  })

  it('413s an oversize body by declared length without parsing it', async () => {
    const stream = new ReadableStream({ pull() {} }, { highWaterMark: 0 })
    const res = await POST(new NextRequest('http://localhost/api/coding/code-systems/import', {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(3 * WEB_IMPORT_LIMITS.maxBytes) }, body: stream, duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1]))
    expect(res.status).toBe(413)
    expect((await res.json()).error).toBe('This file is too large for the web importer (4 MB). Load it with npm run codes:import; see docs/CODE-SYSTEMS.md.')
  })

  it('400s bad JSON, a schema miss and a bad content-length', async () => {
    expect(await (await POST(jsonReq('{not json'))).json()).toEqual({ error: 'Invalid import' })
    const extra = await POST(jsonReq({ ...BODY, extra: 1 }))
    expect(extra.status).toBe(400)
    expect(await extra.json()).toEqual({ error: 'Invalid import' })
    expect((await POST(jsonReq(BODY, { 'content-type': 'application/json', 'content-length': '12abc' }))).status).toBe(400)
  })

  it('dry run never commits; commit audits through the query layer', async () => {
    const dry = await POST(jsonReq({ ...BODY, commit: false }))
    expect(dry.status).toBe(200)
    expect(await dry.json()).toEqual({ ok: true, codeCount: 8, isSample: true })
    expect(commitCodeSystemImport).not.toHaveBeenCalled()

    const res = await POST(jsonReq({ ...BODY, commit: true, makeCurrent: true }))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ codeSystemId: 11, codeCount: 8, isCurrent: true })
    expect(commitCodeSystemImport).toHaveBeenCalledWith(
      { kind: 'icd10', version: 'SAMPLE-ICD10-0', name: 'Sample ICD-10', licenceNote: null, sourceFileName: 'SAMPLE-icd10.csv', sourceSha256: sha256Hex(SAMPLE), makeCurrent: true, isSample: true },
      expect.any(Array),
      { role: 'admin', name: 'Probe', userId: 9 },
    )
    expect(vi.mocked(commitCodeSystemImport).mock.calls[0][1]).toHaveLength(8)
  })

  it('returns line-numbered issues and commits nothing on a bad file', async () => {
    const csv = SAMPLE.replace('U8Z.1,SAMPLE fictional condition A1', 'bad!,SAMPLE SECRET-CELL')
    const res = await POST(jsonReq({ ...BODY, csv, commit: true }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('Invalid import')
    expect(body.issues[0]).toMatchObject({ line: 4, column: 'code' })
    expect(JSON.stringify(body)).not.toContain('SECRET-CELL')
    expect(commitCodeSystemImport).not.toHaveBeenCalled()
  })

  it('requires a licence note for a non-sample version', async () => {
    const res = await POST(jsonReq({ ...BODY, version: 'WHO-2019', commit: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).issues[0]).toMatchObject({ column: 'licenceNote' })
  })

  it('maps a duplicate version to 409', async () => {
    vi.mocked(commitCodeSystemImport).mockRejectedValueOnce(new CodeSystemVersionExistsError())
    const res = await POST(jsonReq({ ...BODY, commit: true }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'That version of this code set is already loaded' })
  })

  it('maps a sample over a licensed set to 409', async () => {
    vi.mocked(commitCodeSystemImport).mockRejectedValueOnce(new SampleOverLicensedError())
    const res = await POST(jsonReq({ ...BODY, commit: true, makeCurrent: true }))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'A sample code set cannot replace a licensed one' })
  })

  it('maps a deadlock to the retry 409 and anything else to a 500 logging only the pg code', async () => {
    vi.mocked(commitCodeSystemImport).mockRejectedValueOnce(Object.assign(new Error('deadlock with row text'), { code: '40P01' }))
    expect((await POST(jsonReq({ ...BODY, commit: true }))).status).toBe(409)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(commitCodeSystemImport).mockRejectedValueOnce(Object.assign(new Error('secret detail'), { code: '23514', constraint: 'codes_age_range' }))
    const res = await POST(jsonReq({ ...BODY, commit: true }))
    expect(res.status).toBe(500)
    expect(spy.mock.calls.flat().join(' ')).not.toContain('secret detail')
    expect(spy.mock.calls.flat().join(' ')).toContain('23514')
    spy.mockRestore()
  })
})

describe('GET /api/coding/code-systems', () => {
  it('lists versions for coding roles only', async () => {
    expect((await GET_LIST()).status).toBe(200)
    sessionRole = 'coder'
    expect((await GET_LIST()).status).toBe(200)
    sessionRole = 'pi'
    expect((await GET_LIST()).status).toBe(403)
  })
})

describe('PATCH /api/coding/code-systems/[id]', () => {
  it('sets the current version and maps not-found and sample-over-licensed', async () => {
    expect((await PATCH(patch({ isCurrent: true }), ctx('5'))).status).toBe(200)
    expect(setCurrentCodeSystem).toHaveBeenCalledWith(5, { role: 'admin', name: 'Probe', userId: 9 })
    vi.mocked(setCurrentCodeSystem).mockResolvedValueOnce('not_found')
    expect((await PATCH(patch({ isCurrent: true }), ctx('5'))).status).toBe(404)
    vi.mocked(setCurrentCodeSystem).mockResolvedValueOnce('sample_over_licensed')
    const res = await PATCH(patch({ isCurrent: true }), ctx('5'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'A sample code set cannot replace a licensed one' })
  })

  it('400s bad JSON, a non-strict body, isCurrent false and a bad id', async () => {
    expect((await PATCH(patch('{nope'), ctx('5'))).status).toBe(400)
    expect((await PATCH(patch({ isCurrent: true, x: 1 }), ctx('5'))).status).toBe(400)
    expect((await PATCH(patch({ isCurrent: false }), ctx('5'))).status).toBe(400)
    expect((await PATCH(patch({ isCurrent: true }), ctx('abc'))).status).toBe(400)
    expect(setCurrentCodeSystem).not.toHaveBeenCalled()
  })

  it('403s a coder before parsing', async () => {
    sessionRole = 'coder'
    const res = await PATCH(patch('{nope'), ctx('5'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })
})

describe('GET /api/coding/codes', () => {
  it('code search validates params and returns hits', async () => {
    expect((await GET_CODES(get('/api/coding/codes?kind=xyz&q=a'))).status).toBe(400)
    const bad = await GET_CODES(get('/api/coding/codes?kind=icd10&q=e11&extra=1'))
    expect(await bad.json()).toEqual({ error: 'Invalid code search' })
    const res = await GET_CODES(get('/api/coding/codes?kind=icd10&q=e11'))
    expect(res.status).toBe(200)
    expect(searchCodes).toHaveBeenCalledWith({ kind: 'icd10', q: 'e11', onDate: null, limit: 20 })
    await GET_CODES(get('/api/coding/codes?kind=snomed&q=heart&on=2026-10-07&limit=5'))
    expect(searchCodes).toHaveBeenLastCalledWith({ kind: 'snomed', q: 'heart', onDate: '2026-10-07', limit: 5 })
  })

  it('admits every lookup role and denies the rest', async () => {
    for (const role of ['admin', 'coder', 'pi', 'crc', 'billing'] as Role[]) {
      sessionRole = role
      expect((await GET_CODES(get('/api/coding/codes?kind=icd10&q=e11'))).status, role).toBe(200)
    }
    for (const role of ['frontdesk', 'pharmacy', 'labs'] as Role[]) {
      sessionRole = role
      expect((await GET_CODES(get('/api/coding/codes?kind=icd10&q=e11'))).status, role).toBe(403)
    }
  })
})
