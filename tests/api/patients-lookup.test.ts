import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import type { Role } from '@/lib/auth'

let sessionRole: Role = 'frontdesk'
let signedIn = true
vi.mock('@/lib/auth', () => ({
  requireSession: vi.fn(async () =>
    signedIn ? { role: sessionRole, name: 'Test WC Lookup', userId: null } : NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  ),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/search', () => ({
  lookupPatients: vi.fn(async (_q: string, opts: { includePhone: boolean; page?: number; pageSize?: number }) => ({
    results: [{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH1', gender: 'female', ageYears: 30, ...(opts.includePhone ? { phone: '+919812345671' } : {}) }],
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 10,
    hasMore: false,
  })),
}))

import { GET } from '@/app/api/patients/lookup/route'
import { lookupPatients } from '@/lib/queries/search'
import { logAudit } from '@/lib/audit'

afterEach(() => {
  sessionRole = 'frontdesk'
  signedIn = true
  vi.mocked(lookupPatients).mockClear()
  vi.mocked(logAudit).mockClear()
})

const lookup = (qs: string) => GET(new NextRequest(`http://localhost/api/patients/lookup?${qs}`))

describe('GET /api/patients/lookup', () => {
  it('401s without a session', async () => {
    signedIn = false
    expect((await lookup('q=asha')).status).toBe(401)
  })

  it('403s labs with the plain body and never queries', async () => {
    sessionRole = 'labs'
    const res = await lookup('q=asha')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(lookupPatients).not.toHaveBeenCalled()
  })

  it.each(['admin', 'crc', 'pi', 'frontdesk'] as const)('returns the mobile number to %s', async (role) => {
    sessionRole = role
    const res = await lookup('q=asha')
    expect(res.status).toBe(200)
    expect(lookupPatients).toHaveBeenCalledWith('asha', expect.objectContaining({ includePhone: true }))
    expect((await res.json()).results[0].phone).toBe('+919812345671')
  })

  it.each(['pharmacy', 'billing'] as const)('never returns the mobile number to %s', async (role) => {
    sessionRole = role
    const res = await lookup('q=9812345671')
    expect(res.status).toBe(200)
    expect(lookupPatients).toHaveBeenCalledWith('9812345671', expect.objectContaining({ includePhone: false }))
    expect((await res.json()).results[0]).not.toHaveProperty('phone')
  })

  it('passes page and pageSize through', async () => {
    await lookup('q=asha&page=2&pageSize=5')
    expect(lookupPatients).toHaveBeenCalledWith('asha', { includePhone: true, page: 2, pageSize: 5 })
  })

  it.each([
    ['unknown parameter', 'q=asha&anonId=RD-0001'],
    ['non-numeric page', 'q=asha&page=two'],
    ['page out of range', 'q=asha&page=0'],
    ['oversize pageSize', 'q=asha&pageSize=500'],
    ['oversize query', `q=${'a'.repeat(101)}`],
  ])('400s a %s without echoing the input', async (_label, qs) => {
    const res = await lookup(qs)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Invalid lookup query' })
    expect(lookupPatients).not.toHaveBeenCalled()
  })

  it('audits a non-empty lookup without the query text (it may be a mobile number)', async () => {
    await lookup('q=9812345671')
    expect(logAudit).toHaveBeenCalledTimes(1)
    const [, action, patientId, details] = vi.mocked(logAudit).mock.calls[0]
    expect(patientId).toBeNull()
    expect(`${action} ${details ?? ''}`).not.toContain('9812345671')
  })

  it('does not audit or query an empty lookup', async () => {
    const res = await lookup('q=')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [], page: 1, pageSize: 10, hasMore: false })
    expect(lookupPatients).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('answers a deadlock with 409 and the retry message', async () => {
    vi.mocked(lookupPatients).mockRejectedValueOnce(Object.assign(new Error('x'), { code: '40P01' }))
    const res = await lookup('q=asha')
    expect(res.status).toBe(409)
  })

  it('500s other failures with a fixed message', async () => {
    vi.mocked(lookupPatients).mockRejectedValueOnce(new Error('select ... asha'))
    const res = await lookup('q=asha')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not look up patients' })
  })

  it('is never cached', async () => {
    const res = await lookup('q=asha')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
