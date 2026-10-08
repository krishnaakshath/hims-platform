import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { Role } from '@/lib/auth'

let role: Role = 'rcm'
vi.mock('@/lib/auth', () => ({ requireSession: vi.fn(async () => ({ role, name: 'Probe', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/rcm-reports', async () => {
  const actual = await vi.importActual<typeof import('@/lib/queries/rcm-reports')>('@/lib/queries/rcm-reports')
  return { ...actual, claimRegisterRows: vi.fn(async () => [actual.CLAIM_REGISTER_HEADER, ['CLM-2099-000001', 'submitted', 'opd', 'UH1', '=cmd()', 'Star', '2099-06-02', '1.00', null, '0.00', '0.00', '0.00', null]]) }
})
import { GET } from '@/app/api/rcm/reports/claims-csv/route'
import { logAudit } from '@/lib/audit'

const req = (qs: string) => new NextRequest(`http://localhost/api/rcm/reports/claims-csv${qs}`)
beforeEach(() => { role = 'rcm'; vi.clearAllMocks() })

describe('GET /api/rcm/reports/claims-csv', () => {
  it('a reversed range is a 400; a valid one is an attachment CSV', async () => {
    const bad = await GET(req('?from=2099-06-30&to=2099-06-01'))
    expect(bad.status).toBe(400); expect(await bad.json()).toEqual({ error: 'Choose a valid date range' })
    const res = await GET(req('?from=2099-06-01&to=2099-06-30'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="claim-register-2099-06-01-to-2099-06-30.csv"')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    const text = await res.text()
    expect(text.split('\r\n')[0]).toBe('Claim number,Status,Claim type,UHID,Patient,Payer,First submitted,Claimed (Rs),Approved (Rs),Settled (Rs),TDS (Rs),Written off (Rs),Insurer reference')
    expect(text).toContain(",'=cmd(),")
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'rcm: exported claim register', null, 'from=2099-06-01 to=2099-06-30 rows=1')
  })
  it('billing is refused', async () => {
    role = 'billing'
    expect((await GET(req('?from=2099-06-01&to=2099-06-30'))).status).toBe(403)
  })
})
