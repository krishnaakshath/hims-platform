import { describe, it, expect, vi, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import type { ReportResult } from '@/lib/reports/table'

// Wave I (P1-23): GET /api/reports/[report]/csv -- per-report role gate before
// anything is read, range validated, every export audited with its range and
// row count.
const state = vi.hoisted(() => ({
  role: 'admin',
  logAudit: vi.fn(async () => undefined),
  opd: vi.fn(),
  revenue: vi.fn(),
}))
vi.mock('@/lib/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
  return { ...actual, requireSession: vi.fn(async () => ({ role: state.role, name: 'Test', userId: null })) }
})
vi.mock('@/lib/audit', () => ({ logAudit: state.logAudit }))
vi.mock('@/lib/queries/hospital-reports', () => ({
  HOSPITAL_REPORT_QUERIES: new Proxy({}, { get: (_t, key) => (key === 'opd' ? state.opd : state.revenue) }),
}))

import { GET } from '@/app/api/reports/[report]/csv/route'

const RESULT: ReportResult = {
  sections: [
    { title: 'By department', columns: [{ label: 'Department', kind: 'text' }, { label: 'Visits', kind: 'int' }], rows: [['General Medicine', 3], ['Cardiology', 2]], empty: '-' },
    { title: 'By day', columns: [{ label: 'Date', kind: 'date' }, { label: 'Visits', kind: 'int' }], rows: [['2026-10-01', 5]], empty: '-' },
  ],
}
const call = (report: string, qs: string) => GET(new NextRequest(`http://localhost/api/reports/${report}/csv${qs}`), { params: Promise.resolve({ report }) })

afterEach(() => {
  state.role = 'admin'
  state.logAudit.mockClear()
  state.opd.mockReset()
  state.revenue.mockReset()
})

describe('GET /api/reports/[report]/csv', () => {
  it('returns the report as an attachment CSV and audits the export', async () => {
    state.opd.mockResolvedValue(RESULT)
    const res = await call('opd', '?from=2026-10-01&to=2026-10-08')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="opd-2026-10-01-to-2026-10-08.csv"')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const body = new TextDecoder().decode(bytes)
    expect(body).toContain('OPD statistics,2026-10-01,2026-10-08\r\n')
    expect(body).toContain('General Medicine,3\r\n')
    expect(state.opd).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-08' })
    expect(state.logAudit).toHaveBeenCalledWith(expect.anything(), 'exported report: OPD statistics', null, 'from=2026-10-01&to=2026-10-08&rows=3')
  })

  it('403s a role outside the report\'s list before reading the range or querying', async () => {
    state.role = 'billing'
    const res = await call('opd', '?from=bad')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Forbidden' })
    expect(state.opd).not.toHaveBeenCalled()
    expect(state.logAudit).not.toHaveBeenCalled()
  })

  it('lets each report\'s own roles in (billing exports department revenue)', async () => {
    state.role = 'billing'
    state.revenue.mockResolvedValue({ sections: [] })
    const res = await call('department-revenue', '?from=2026-10-01&to=2026-10-08')
    expect(res.status).toBe(200)
  })

  it('403s an unknown report for every role', async () => {
    for (const report of ['nope', '__proto__', 'constructor']) {
      const res = await call(report, '?from=2026-10-01&to=2026-10-08')
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'Forbidden' })
    }
  })

  it.each([['', 'Choose a valid date range'], ['?from=2026-10-09&to=2026-10-01', 'Choose a valid date range'], ['?from=2024-01-01&to=2026-10-01', 'Choose at most 366 days']])('400s range %s without querying or auditing', async (qs, error) => {
    const res = await call('opd', qs)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error })
    expect(state.opd).not.toHaveBeenCalled()
    expect(state.logAudit).not.toHaveBeenCalled()
  })
})
