import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { CodingWorklistRow, CodingProductivity } from '@/lib/queries/coding-worklist'
import { todayIsoIn } from '@/lib/india-time'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const row = (o: Partial<CodingWorklistRow> = {}): CodingWorklistRow => ({
  encounterId: 7,
  encounterType: 'opd',
  encounterDate: '2026-10-01',
  completedAt: new Date('2026-10-01T06:00:00Z'),
  completedIstDate: '2026-10-01',
  patientId: 'P-1',
  patientName: 'Asha Rao',
  uhid: 'UH-0001',
  departmentName: 'Cardiology',
  providerName: 'Dr. K',
  codingStatus: 'uncoded',
  assignedToName: null,
  assignedToUserId: null,
  uncodedCount: 2,
  proposedCount: 1,
  openQueryCount: 0,
  ageBucket: '3-7',
  ...o,
})

const COUNTS = { uncoded: 1, in_progress: 1, queried: 0, coded: 0, finalised: 4 }
const refresh = vi.fn()

async function renderWorklist(opts: { role?: string; sp?: Record<string, string>; rows?: CodingWorklistRow[]; total?: number } = {}) {
  vi.resetModules()
  refresh.mockClear()
  const role = opts.role ?? 'coder'
  const rows = opts.rows ?? [row(), row({ encounterId: 8, patientName: 'Bala N', uhid: 'UH-0002', codingStatus: 'in_progress', assignedToName: 'Asha Coder', assignedToUserId: 5, uncodedCount: 0, proposedCount: 0, openQueryCount: 1, ageBucket: '31+' })]
  const logAudit = vi.fn(async () => undefined)
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  const listCodingWorklist = vi.fn(async () => ({ rows, total: opts.total ?? rows.length, counts: COUNTS }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester', userId: 5 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('@/lib/queries/coding-worklist', () => ({ listCodingWorklist }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: vi.fn(async () => [{ id: 2, name: 'Cardiology', code: 'SECRET-DEPT-CODE' }]) }))
  vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }), redirect }))
  const { default: Page } = await import('@/app/(dashboard)/coding/page')
  const { render, screen, within } = await import('@testing-library/react')
  const jsx = await Page({ searchParams: Promise.resolve(opts.sp ?? {}) })
  const utils = render(jsx)
  return { screen, within, logAudit, listCodingWorklist, redirect, ...utils }
}

describe('/coding worklist', () => {
  it('renders rows with status labels and a claim button for unassigned rows', async () => {
    const { screen, within } = await renderWorklist()
    const table = screen.getByRole('table')
    expect(within(table).getByText('Not started')).toBeInTheDocument()
    expect(within(table).getByText('UH-0001')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Asha Rao' })).toHaveAttribute('href', '/coding/encounters/7')
    expect(screen.getByText('2 uncoded · 1 proposed · 0 queries')).toBeInTheDocument()
    expect(screen.getByText('3–7 days')).toBeInTheDocument()
    // One Claim button: the unassigned row only; the claimed row shows its assignee.
    expect(screen.getAllByRole('button', { name: /^claim/i })).toHaveLength(1)
    expect(screen.getByText('Asha Coder')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /productivity report/i })).toHaveAttribute('href', '/coding/report')
  })

  it('shows the empty state', async () => {
    const { screen } = await renderWorklist({ rows: [], total: 0 })
    expect(screen.getByText('Nothing is waiting for coding.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('passes the parsed filters and session to the query, and is not audited (a list, no patient view)', async () => {
    const { listCodingWorklist, logAudit } = await renderWorklist({ sp: { status: 'in_progress', assignee: 'mine', type: 'ipd', department: '2', page: '2' } })
    expect(listCodingWorklist).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in_progress', assignee: 'mine', encounterType: 'ipd', departmentId: 2, page: 2 }),
      expect.objectContaining({ role: 'coder', userId: 5 }),
    )
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('shows status tabs with counts from the raw count query', async () => {
    const { screen } = await renderWorklist()
    expect(screen.getByRole('link', { name: 'All pending (2)' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: 'Finalised (4)' })).toBeInTheDocument()
  })

  it('shows "Showing a–b of N" from the raw total, with a next-page link', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row({ encounterId: 100 + i, uhid: `UH-${i}` }))
    const { screen } = await renderWorklist({ rows, total: 120, sp: { status: 'uncoded' } })
    expect(screen.getByText('Showing 1–50 of 120')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /next page/i }).getAttribute('href')).toBe('/coding?status=uncoded&page=2')
  })

  it('sends only id and name of departments to the page', async () => {
    const { container } = await renderWorklist()
    expect(container.innerHTML).not.toContain('SECRET-DEPT-CODE')
    expect(container.querySelector('option[value="2"]')?.textContent).toBe('Cardiology')
  })

  it('redirects a denied role before loading anything', async () => {
    vi.resetModules()
    const listCodingWorklist = vi.fn()
    const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Dr', userId: 1 })) }))
    vi.doMock('@/lib/queries/coding-worklist', () => ({ listCodingWorklist }))
    vi.doMock('next/navigation', () => ({ redirect }))
    const { default: Page } = await import('@/app/(dashboard)/coding/page')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
    expect(listCodingWorklist).not.toHaveBeenCalled()
  })

  it('claims through the status route and refreshes; a 409 shows the server message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Another coder has already claimed this encounter' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'in_progress', issues: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { screen } = await renderWorklist()
    fireEvent.click(screen.getByRole('button', { name: /^claim/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Another coder has already claimed this encounter')
    expect(fetchMock).toHaveBeenCalledWith('/api/coding/encounters/7/status', expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'claim' }) }))
    expect(refresh).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^claim/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })
})

const PRODUCTIVITY: CodingProductivity = {
  from: '2026-10-01',
  to: '2026-10-08',
  perCoder: [{ name: 'Asha Coder', claimed: 4, coded: 3, finalised: 2, queriesRaised: 1, reopened: 0, medianHoursToFinalise: 5.5 }],
  backlog: {
    byStatus: { uncoded: 3, in_progress: 2, queried: 1, coded: 0, finalised: 0 },
    byAge: { '0-2': 2, '3-7': 2, '8-30': 1, '31+': 1 },
    oldestCompletedDate: '2026-08-15',
  },
}

async function renderReport(sp: Record<string, string> = {}, role = 'admin') {
  vi.resetModules()
  const logAudit = vi.fn(async () => undefined)
  const getCodingProductivity = vi.fn(async () => PRODUCTIVITY)
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester', userId: 1 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('@/lib/queries/coding-worklist', () => ({ getCodingProductivity }))
  vi.doMock('next/navigation', () => ({ redirect }))
  const { default: Page } = await import('@/app/(dashboard)/coding/report/page')
  const { render, screen } = await import('@testing-library/react')
  const jsx = await Page({ searchParams: Promise.resolve(sp) })
  render(jsx)
  return { screen, logAudit, getCodingProductivity, redirect }
}

describe('/coding/report', () => {
  it('defaults to the first of the current IST month through today, and audits the view', async () => {
    const today = todayIsoIn()
    const { getCodingProductivity, logAudit } = await renderReport()
    expect(getCodingProductivity).toHaveBeenCalledWith({ from: `${today.slice(0, 8)}01`, to: today })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'admin' }), 'coding: viewed productivity report', null, `from=${today.slice(0, 8)}01 to=${today}`)
  })

  it('uses a valid range from the params and renders per-coder and backlog tables', async () => {
    const { screen, getCodingProductivity } = await renderReport({ from: '2026-09-01', to: '2026-09-30' })
    expect(getCodingProductivity).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-30' })
    expect(screen.getByRole('cell', { name: 'Asha Coder' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '5.5' })).toBeInTheDocument()
    expect(screen.getByText('Over 30 days')).toBeInTheDocument()
    expect(screen.getByText(/15 Aug 2026/)).toBeInTheDocument()
  })

  it('redirects a denied role before loading anything', async () => {
    vi.resetModules()
    const getCodingProductivity = vi.fn()
    const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'billing', name: 'B', userId: 1 })) }))
    vi.doMock('@/lib/queries/coding-worklist', () => ({ getCodingProductivity }))
    vi.doMock('next/navigation', () => ({ redirect }))
    const { default: Page } = await import('@/app/(dashboard)/coding/report/page')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(getCodingProductivity).not.toHaveBeenCalled()
  })
})
