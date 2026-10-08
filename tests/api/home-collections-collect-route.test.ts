// SP5 Task 12: POST /api/home-collections/[id]/collect, with the session and the query mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let role: Role = 'collector'
let userId: number | null = 7
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () => ({ role, name: 'TEST_SP5_probe', userId })),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/home-collections', () => ({ collectHomeVisit: vi.fn() }))

import { POST } from '@/app/api/home-collections/[id]/collect/route'
import { collectHomeVisit } from '@/lib/queries/home-collections'
import { displaySampleId, formatSampleId } from '@/lib/labs/sample-id'

const SID = formatSampleId('2099-06-02', 42)
const OTHER = formatSampleId('2099-06-02', 43)
const TYPO = `${SID.slice(0, -1)}${(Number(SID.at(-1)) + 1) % 10}`
const send = (body: unknown, id = '77') =>
  POST(new NextRequest(`http://localhost/api/home-collections/${id}/collect`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), { params: Promise.resolve({ id }) })

beforeEach(() => {
  role = 'collector'
  userId = 7
  vi.mocked(collectHomeVisit).mockReset()
})

describe('POST /api/home-collections/[id]/collect', () => {
  it.each(['frontdesk', 'labs', 'pi', 'crc', 'billing', 'pharmacy'] as Role[])('%s is 403 before parsing', async (r) => {
    role = r
    const res = await send('not json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(collectHomeVisit).not.toHaveBeenCalled()
  })

  it('400s a typo before calling the query; 409 names the wrong tube', async () => {
    const typo = await send({ sampleIds: [SID, TYPO] })
    expect(typo.status).toBe(400)
    expect(await typo.json()).toEqual({ error: `Sample ID ${TYPO} is not valid. Re-scan or re-type it.` })
    expect(collectHomeVisit).not.toHaveBeenCalled()

    vi.mocked(collectHomeVisit).mockResolvedValue({ ok: false, error: 'sample_not_on_visit', sampleId: OTHER })
    const wrong = await send({ sampleIds: [displaySampleId(OTHER)] })
    expect(wrong.status).toBe(409)
    expect(await wrong.json()).toEqual({ error: `Sample ${displaySampleId(OTHER)} does not belong to this visit. Check the tube label.` })
    expect(collectHomeVisit).toHaveBeenCalledWith(77, [displaySampleId(OTHER)], expect.objectContaining({ role: 'collector', userId: 7 }))
  })

  it('a duplicate tube is 400 before the query', async () => {
    const res = await send({ sampleIds: [SID, displaySampleId(SID)] })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: `Sample ID ${displaySampleId(SID)} is not valid. Re-scan or re-type it.` })
    expect(collectHomeVisit).not.toHaveBeenCalled()
  })

  it('bad JSON, a bad body and a bad id are 400 before the query', async () => {
    expect((await send('not json')).status).toBe(400)
    expect((await send({})).status).toBe(400)
    expect((await send({ sampleIds: [] })).status).toBe(400)
    expect((await send({ sampleIds: [SID], extra: 1 })).status).toBe(400)
    expect((await send({ sampleIds: [SID] }, 'abc')).status).toBe(400)
    expect(collectHomeVisit).not.toHaveBeenCalled()
  })

  it("another collector's visit is a plain 403", async () => {
    vi.mocked(collectHomeVisit).mockResolvedValue({ ok: false, error: 'not_assigned' })
    const res = await send({ sampleIds: [SID] })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
  })

  it('maps not_found, not_collectable, a query-side invalid ID and a deadlock', async () => {
    vi.mocked(collectHomeVisit).mockResolvedValueOnce({ ok: false, error: 'not_found' })
    expect((await send({ sampleIds: [SID] })).status).toBe(404)
    vi.mocked(collectHomeVisit).mockResolvedValueOnce({ ok: false, error: 'not_collectable' })
    const nc = await send({ sampleIds: [SID] })
    expect(nc.status).toBe(409)
    expect((await nc.json()).error).toMatch(/already been collected or cancelled/)
    vi.mocked(collectHomeVisit).mockResolvedValueOnce({ ok: false, error: 'invalid_sample_id', sampleId: SID })
    expect((await send({ sampleIds: [SID] })).status).toBe(400)
    vi.mocked(collectHomeVisit).mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
    expect((await send({ sampleIds: [SID] })).status).toBe(409)
  })

  it('200 with the result for the assigned collector and for admin', async () => {
    const ok = { ok: true as const, collectedOrderIds: [11], notCollectedOrderIds: [12], encounterId: 5 }
    vi.mocked(collectHomeVisit).mockResolvedValue(ok)
    const res = await send({ sampleIds: [` ${displaySampleId(SID)} `] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(ok)
    role = 'admin'
    userId = null
    expect((await send({ sampleIds: [SID] })).status).toBe(200)
  })
})
