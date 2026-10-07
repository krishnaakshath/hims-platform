// SP6 Task 9: the encounter coding entry, status and query routes. The query modules are mocked
// (their DB behaviour is tests/lib/queries/coding*.test.ts); the zod schemas and the error
// catalogue are real. Covers: 401/403 before parse, the per-action role gate, error mapping,
// bad JSON / unknown keys / bad ids, the deadlock 409, the 500 log, and the patient-detail
// cache invalidation after diagnosis writes.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'
import { CODING_ERROR_MESSAGE } from '@/lib/coding/errors'
import type { CodingIssue } from '@/lib/coding/rules'
import { RETRY_MESSAGE } from '@/lib/db-errors'

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
vi.mock('@/lib/cache', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cache')>('@/lib/cache')
  return { ...actual, invalidateCache: vi.fn(async () => undefined) }
})
vi.mock('@/lib/queries/coding', () => ({
  addEncounterDiagnosis: vi.fn(), updateEncounterDiagnosis: vi.fn(), voidEncounterDiagnosis: vi.fn(),
  addEncounterProcedure: vi.fn(), updateEncounterProcedure: vi.fn(), voidEncounterProcedure: vi.fn(),
  applyCodingAction: vi.fn(),
}))
vi.mock('@/lib/queries/coding-queries', () => ({
  raiseCodingQuery: vi.fn(), respondToCodingQuery: vi.fn(), closeCodingQuery: vi.fn(),
}))

import { invalidateCache, patientDetailCacheKey } from '@/lib/cache'
import {
  addEncounterDiagnosis, addEncounterProcedure, applyCodingAction, updateEncounterDiagnosis, updateEncounterProcedure,
  voidEncounterDiagnosis, voidEncounterProcedure,
} from '@/lib/queries/coding'
import { closeCodingQuery, raiseCodingQuery, respondToCodingQuery } from '@/lib/queries/coding-queries'
import { POST as postDx } from '@/app/api/coding/encounters/[id]/diagnoses/route'
import { PATCH as patchDx, DELETE as deleteDx } from '@/app/api/coding/encounters/[id]/diagnoses/[diagnosisId]/route'
import { POST as postProc } from '@/app/api/coding/encounters/[id]/procedures/route'
import { PATCH as patchProc, DELETE as deleteProc } from '@/app/api/coding/encounters/[id]/procedures/[procedureId]/route'
import { POST as postStatus } from '@/app/api/coding/encounters/[id]/status/route'
import { POST as postQuery } from '@/app/api/coding/encounters/[id]/queries/route'
import { PATCH as patchQuery } from '@/app/api/coding/queries/[queryId]/route'
import { POST as postResponse } from '@/app/api/coding/queries/[queryId]/responses/route'

const ISSUE: CodingIssue = { code: 'primary_missing', severity: 'error', entry: null, message: 'Add a primary diagnosis' }
const OK_DX = { type: 'primary', codeId: 1 }
const req = (body: unknown, method = 'POST') =>
  new NextRequest('http://localhost/api/coding/x', { method, body: typeof body === 'string' ? body : JSON.stringify(body) })
const del = () => new NextRequest('http://localhost/api/coding/x', { method: 'DELETE' })
const ctx = (id: string | number) => ({ params: Promise.resolve({ id: String(id) }) })
const ctxDx = (id: string | number, diagnosisId: string | number) => ({ params: Promise.resolve({ id: String(id), diagnosisId: String(diagnosisId) }) })
const ctxProc = (id: string | number, procedureId: string | number) => ({ params: Promise.resolve({ id: String(id), procedureId: String(procedureId) }) })
const ctxQ = (queryId: string | number) => ({ params: Promise.resolve({ queryId: String(queryId) }) })
const as = (r: Role | null) => { sessionRole = r }

const ALL: Role[] = ['admin', 'crc', 'pi', 'frontdesk', 'billing', 'pharmacy', 'labs', 'coder']

beforeEach(() => {
  as('coder')
  vi.mocked(invalidateCache).mockReset().mockResolvedValue(undefined)
  vi.mocked(addEncounterDiagnosis).mockReset().mockResolvedValue({ ok: true, value: { diagnosisId: 41, patientId: 'P-1', warnings: [] } })
  vi.mocked(updateEncounterDiagnosis).mockReset().mockResolvedValue({ ok: true, value: { diagnosisId: 41, patientId: 'P-1', warnings: [] } })
  vi.mocked(voidEncounterDiagnosis).mockReset().mockResolvedValue({ ok: true, value: { diagnosisId: 41, patientId: 'P-1' } })
  vi.mocked(addEncounterProcedure).mockReset().mockResolvedValue({ ok: true, value: { procedureId: 51, warnings: [] } })
  vi.mocked(updateEncounterProcedure).mockReset().mockResolvedValue({ ok: true, value: { procedureId: 51, warnings: [] } })
  vi.mocked(voidEncounterProcedure).mockReset().mockResolvedValue({ ok: true, value: { procedureId: 51 } })
  vi.mocked(applyCodingAction).mockReset().mockResolvedValue({ ok: true, value: { status: 'in_progress', issues: [] } })
  vi.mocked(raiseCodingQuery).mockReset().mockResolvedValue({ ok: true, value: { queryId: 61 } })
  vi.mocked(respondToCodingQuery).mockReset().mockResolvedValue({ ok: true, value: { responseId: 71 } })
  vi.mocked(closeCodingQuery).mockReset().mockResolvedValue({ ok: true, value: { status: 'closed' } })
})

describe('gates', () => {
  it('401s without a session on every route', async () => {
    as(null)
    expect((await postDx(req(OK_DX), ctx(7))).status).toBe(401)
    expect((await patchDx(req({ type: 'secondary' }, 'PATCH'), ctxDx(7, 41))).status).toBe(401)
    expect((await deleteDx(del(), ctxDx(7, 41))).status).toBe(401)
    expect((await postProc(req({}), ctx(7))).status).toBe(401)
    expect((await patchProc(req({}, 'PATCH'), ctxProc(7, 51))).status).toBe(401)
    expect((await deleteProc(del(), ctxProc(7, 51))).status).toBe(401)
    expect((await postStatus(req({ action: 'claim' }), ctx(7))).status).toBe(401)
    expect((await postQuery(req({}), ctx(7))).status).toBe(401)
    expect((await patchQuery(req({ action: 'close' }, 'PATCH'), ctxQ(61))).status).toBe(401)
    expect((await postResponse(req({ body: 'x' }), ctxQ(61))).status).toBe(401)
  })

  it('entry routes admit admin, coder and pi only, denying before the body is read', async () => {
    for (const role of ALL) {
      as(role)
      const r = await postDx(req('{not json'), ctx(7))
      if (['admin', 'coder', 'pi'].includes(role)) expect(r.status, role).toBe(400)
      else { expect(r.status, role).toBe(403); expect(await r.json()).toEqual({ error: 'Forbidden' }) }
    }
    expect(addEncounterDiagnosis).not.toHaveBeenCalled()
  })

  it('a pi cannot run a status action; a coder cannot assign', async () => {
    as('pi'); expect((await postStatus(req({ action: 'claim' }), ctx(7))).status).toBe(403)
    as('coder')
    const r = await postStatus(req({ action: 'assign', assigneeUserId: 3 }), ctx(7))
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'Forbidden' })
    expect(applyCodingAction).not.toHaveBeenCalled()
    as('admin')
    expect((await postStatus(req({ action: 'assign', assigneeUserId: 3 }), ctx(7))).status).toBe(200)
    expect(applyCodingAction).toHaveBeenCalledWith(7, { action: 'assign', assigneeUserId: 3 }, expect.objectContaining({ role: 'admin' }))
  })

  it('raising and closing queries are for coding roles; any pi, admin or coder may reply', async () => {
    as('pi')
    expect((await postQuery(req({ addressedToProviderId: 2, question: 'Which side?' }), ctx(7))).status).toBe(403)
    expect((await patchQuery(req({ action: 'close' }, 'PATCH'), ctxQ(61))).status).toBe(403)
    expect((await postResponse(req({ body: 'Left side' }), ctxQ(61))).status).toBe(201)
    as('crc')
    expect((await postResponse(req({ body: 'x' }), ctxQ(61))).status).toBe(403)
    expect(raiseCodingQuery).not.toHaveBeenCalled()
    expect(closeCodingQuery).not.toHaveBeenCalled()
  })
})

describe('entries', () => {
  it('adds a diagnosis (201 with id and warnings) and invalidates the patient detail cache', async () => {
    const r = await postDx(req(OK_DX), ctx(7))
    expect(r.status).toBe(201)
    expect(await r.json()).toEqual({ id: 41, warnings: [] })
    expect(addEncounterDiagnosis).toHaveBeenCalledWith(7, OK_DX, expect.objectContaining({ role: 'coder' }))
    expect(invalidateCache).toHaveBeenCalledWith(patientDetailCacheKey('P-1'))
  })

  it('a pi proposes through the same route', async () => {
    as('pi')
    expect((await postDx(req({ type: 'secondary', description: 'Chest pain' }), ctx(7))).status).toBe(201)
  })

  it('updates and voids a diagnosis (200), invalidating the cache each time', async () => {
    const u = await patchDx(req({ type: 'secondary' }, 'PATCH'), ctxDx(7, 41))
    expect(u.status).toBe(200)
    expect(await u.json()).toEqual({ id: 41, warnings: [] })
    expect(updateEncounterDiagnosis).toHaveBeenCalledWith(7, 41, { type: 'secondary' }, expect.anything())
    const d = await deleteDx(del(), ctxDx(7, 41))
    expect(d.status).toBe(200)
    expect(voidEncounterDiagnosis).toHaveBeenCalledWith(7, 41, expect.anything())
    expect(invalidateCache).toHaveBeenCalledTimes(2)
  })

  it('a failing cache invalidation still returns success', async () => {
    vi.mocked(invalidateCache).mockRejectedValueOnce(new Error('redis down'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await postDx(req(OK_DX), ctx(7))).status).toBe(201)
    spy.mockRestore()
  })

  it('procedures: add 201, update 200, void 200', async () => {
    const a = await postProc(req({ codeId: 3, performedOn: '2026-10-01' }), ctx(7))
    expect(a.status).toBe(201)
    expect(await a.json()).toEqual({ id: 51, warnings: [] })
    expect((await patchProc(req({ sequence: 2 }, 'PATCH'), ctxProc(7, 51))).status).toBe(200)
    expect((await deleteProc(del(), ctxProc(7, 51))).status).toBe(200)
    expect(voidEncounterProcedure).toHaveBeenCalledWith(7, 51, expect.anything())
  })

  it('maps write errors to status and message, with issues for 422', async () => {
    vi.mocked(applyCodingAction).mockResolvedValueOnce({ ok: false, error: 'validation_failed', issues: [ISSUE] })
    const r = await postStatus(req({ action: 'finalise' }), ctx(7))
    expect(r.status).toBe(422)
    expect(await r.json()).toEqual({ error: CODING_ERROR_MESSAGE.validation_failed, issues: [ISSUE] })
    vi.mocked(addEncounterDiagnosis).mockResolvedValueOnce({ ok: false, error: 'locked' })
    const l = await postDx(req(OK_DX), ctx(7))
    expect(l.status).toBe(409)
    expect(await l.json()).toEqual({ error: CODING_ERROR_MESSAGE.locked })
    vi.mocked(voidEncounterProcedure).mockResolvedValueOnce({ ok: false, error: 'entry_not_found' })
    expect((await deleteProc(del(), ctxProc(7, 51))).status).toBe(404)
    vi.mocked(respondToCodingQuery).mockResolvedValueOnce({ ok: false, error: 'query_closed' })
    expect((await postResponse(req({ body: 'x' }), ctxQ(61))).status).toBe(409)
    expect(invalidateCache).not.toHaveBeenCalled()
  })

  it('bad JSON is a 400, unknown keys are a 400, a bad id is a 400 -- and nothing is echoed', async () => {
    const j = await postDx(req('{not json'), ctx(7))
    expect(j.status).toBe(400)
    expect(await j.json()).toEqual({ error: 'Invalid JSON' })
    const k = await postDx(req({ type: 'primary', codeId: 1, codingStatus: 'SECRET-coded' }), ctx(7))
    expect(k.status).toBe(400)
    expect(JSON.stringify(await k.json())).not.toContain('codingStatus')
    const b = await postDx(req(OK_DX), ctx('abc'))
    expect(b.status).toBe(400)
    expect(await b.json()).toEqual({ error: 'Invalid id' })
    expect((await patchDx(req({ type: 'secondary' }, 'PATCH'), ctxDx(7, '0'))).status).toBe(400)
    expect((await deleteProc(del(), ctxProc('7.5', 51))).status).toBe(400)
    expect((await patchQuery(req({ action: 'close' }, 'PATCH'), ctxQ('-1'))).status).toBe(400)
    const s = await postStatus(req({ action: 'reopen' }), ctx(7))
    expect(s.status).toBe(400)
    expect(addEncounterDiagnosis).not.toHaveBeenCalled()
    expect(applyCodingAction).not.toHaveBeenCalled()
  })

  it('a deadlock is a retryable 409; anything else is a 500 that logs only the pg code', async () => {
    vi.mocked(addEncounterDiagnosis).mockRejectedValueOnce(Object.assign(new Error('deadlock text'), { code: '40P01' }))
    const r = await postDx(req(OK_DX), ctx(7))
    expect(r.status).toBe(409)
    expect(await r.json()).toEqual({ error: RETRY_MESSAGE })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(applyCodingAction).mockRejectedValueOnce(Object.assign(new Error('secret detail'), { code: '23514', constraint: 'x_check' }))
    const s = await postStatus(req({ action: 'claim' }), ctx(7))
    expect(s.status).toBe(500)
    expect(await s.json()).toEqual({ error: 'Could not save the coding change' })
    const logged = spy.mock.calls.flat().join(' ')
    expect(logged).toContain('[coding]')
    expect(logged).toContain('23514')
    expect(logged).not.toContain('secret detail')
    spy.mockRestore()
  })
})

describe('status and queries', () => {
  it('a status action returns the new status and issues', async () => {
    vi.mocked(applyCodingAction).mockResolvedValueOnce({ ok: true, value: { status: 'coded', issues: [{ ...ISSUE, severity: 'warning' }] } })
    const r = await postStatus(req({ action: 'mark_coded' }), ctx(7))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ status: 'coded', issues: [{ ...ISSUE, severity: 'warning' }] })
  })

  it('raises a query (201), closes it (200) and records a reply (201)', async () => {
    const q = await postQuery(req({ addressedToProviderId: 2, question: 'Which side?' }), ctx(7))
    expect(q.status).toBe(201)
    expect(await q.json()).toEqual({ id: 61 })
    expect(raiseCodingQuery).toHaveBeenCalledWith(7, { addressedToProviderId: 2, question: 'Which side?' }, expect.anything())
    const c = await patchQuery(req({ action: 'withdraw' }, 'PATCH'), ctxQ(61))
    expect(c.status).toBe(200)
    expect(closeCodingQuery).toHaveBeenCalledWith(61, 'withdraw', expect.anything())
    const a = await postResponse(req({ body: 'Left' }), ctxQ(61))
    expect(a.status).toBe(201)
    expect(await a.json()).toEqual({ id: 71 })
    expect(respondToCodingQuery).toHaveBeenCalledWith(61, 'Left', expect.anything())
  })

  it('a strict query body refuses extra keys', async () => {
    expect((await postQuery(req({ addressedToProviderId: 2, question: 'q', status: 'closed' }), ctx(7))).status).toBe(400)
    expect((await patchQuery(req({ action: 'delete' }, 'PATCH'), ctxQ(61))).status).toBe(400)
  })
})
