import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'

// Wave F P1-04: GET /api/encounters/register/export.
const state = vi.hoisted(() => ({
  role: 'admin',
  logAudit: vi.fn(async () => undefined),
  list: vi.fn(),
}))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: state.role, name: 'Test', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: state.logAudit }))
vi.mock('@/lib/queries/encounter-register', () => ({ listEncounterRegister: state.list }))

import { GET } from '@/app/api/encounters/register/export/route'

const ROW = {
  id: 9, encounterDate: '2026-10-08', opdToken: 4, encounterType: 'opd', visitType: 'new', status: 'completed',
  checkedInAt: new Date('2026-10-08T03:45:00Z'), completedAt: null,
  patientId: 'RD-0042', patientName: 'Asha Rao', uhid: 'UH-000042', ageYears: 46, gender: 'female',
  departmentName: 'General Medicine', doctorName: 'Dr. Meera Iyer',
}
const req = (qs: string) => new NextRequest(`http://localhost/api/encounters/register/export${qs}`)

afterEach(() => {
  state.role = 'admin'
  state.logAudit.mockClear()
  state.list.mockReset()
})

describe('GET /api/encounters/register/export', () => {
  it('returns an attachment CSV for the filters and audits the export with its filters and row count', async () => {
    state.list.mockResolvedValue({ rows: [ROW], total: 1, truncated: false, statusCounts: {} })
    const res = await GET(req('?from=2026-10-01&to=2026-10-08&department=3'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="opd-register-2026-10-01-to-2026-10-08.csv"')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const bytes = new Uint8Array(await res.arrayBuffer())
    // UTF-8 BOM, then the header.
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const body = new TextDecoder().decode(bytes)
    expect(body.startsWith('Date,Token,UHID')).toBe(true)
    expect(body).toContain('Asha Rao')
    expect(state.list).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-08', type: 'opd', status: null, departmentId: 3, providerId: null })
    expect(state.logAudit).toHaveBeenCalledWith(expect.anything(), 'exported OPD register', null, 'from=2026-10-01&to=2026-10-08&type=opd&department=3&rows=1')
  })

  it('flags a truncated export', async () => {
    state.list.mockResolvedValue({ rows: [ROW], total: 5000, truncated: true, statusCounts: {} })
    const res = await GET(req(''))
    expect(res.headers.get('x-register-truncated')).toBe('1')
    expect(state.logAudit).toHaveBeenCalledWith(expect.anything(), 'exported OPD register', null, expect.stringContaining('truncated=1'))
  })

  it('400s an invalid filter without querying or auditing', async () => {
    const res = await GET(req('?from=2026-13-01'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: expect.any(String) })
    expect(state.list).not.toHaveBeenCalled()
    expect(state.logAudit).not.toHaveBeenCalled()
  })

  it.each(['pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector'])('403s %s before reading the filters', async (role) => {
    state.role = role
    const res = await GET(req('?from=garbage'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(state.list).not.toHaveBeenCalled()
  })
})
