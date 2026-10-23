import { describe, it, expect, vi } from 'vitest'

const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))

const ENTRIES = [
  { id: 1, userName: 'Sam Patel', role: 'admin', action: 'viewed patient list', patientUhid: null, timestamp: new Date('2026-09-25T10:00:00Z'), details: null },
  { id: 2, userName: 'Jamie Ruiz', role: 'pharmacy', action: 'dispensed drug', patientUhid: 'UH000042', timestamp: new Date('2026-09-25T09:00:00Z'), details: null },
]
const NEXT = { ts: '2026-09-25T09:00:00.000000', id: 2 }

async function loadPage(role: string, listImpl = vi.fn(async () => ({ entries: ENTRIES, nextCursor: NEXT }))) {
  vi.resetModules()
  vi.doMock('next/navigation', () => ({ redirect: mockRedirect }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}` })) }))
  vi.doMock('@/lib/queries/audit-log', async () => {
    const actual = await vi.importActual<typeof import('@/lib/queries/audit-log')>('@/lib/queries/audit-log')
    return { ...actual, listAuditLog: listImpl }
  })
  const { default: AuditLogPage } = await import('@/app/(dashboard)/audit-log/page')
  return { AuditLogPage, listImpl }
}

const sp = (o: Record<string, string>) => Promise.resolve(o)

describe('Audit Log page (/audit-log)', () => {
  it('redirects a non-admin (CRC) session away instead of rendering', async () => {
    const { AuditLogPage } = await loadPage('crc')
    await AuditLogPage({ searchParams: sp({}) })
    expect(mockRedirect).toHaveBeenCalledWith('/')
  })

  it('redirects a non-admin (PI) session away instead of rendering', async () => {
    mockRedirect.mockClear()
    const { AuditLogPage } = await loadPage('pi')
    await AuditLogPage({ searchParams: sp({}) })
    expect(mockRedirect).toHaveBeenCalledWith('/')
  })

  it('renders entries with the UHID, a Next page link and an Export CSV link that keep the filters', async () => {
    const { AuditLogPage, listImpl } = await loadPage('admin')
    const jsx = await AuditLogPage({ searchParams: sp({ role: 'pharmacy', from: '2026-09-01' }) })
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(listImpl).toHaveBeenCalledWith({ role: 'pharmacy', from: '2026-09-01' }, undefined)
    expect(screen.getByText('Sam Patel')).toBeInTheDocument()
    expect(screen.getByText('dispensed drug')).toBeInTheDocument()
    expect(screen.getByText('UH000042')).toBeInTheDocument()
    const next = screen.getByRole('link', { name: 'Next page' }).getAttribute('href') ?? ''
    const nextParams = new URL(next, 'http://x').searchParams
    expect(nextParams.get('role')).toBe('pharmacy')
    expect(nextParams.get('from')).toBe('2026-09-01')
    expect(nextParams.get('cursor')).toBeTruthy()
    const exportHref = screen.getByRole('link', { name: 'Export CSV' }).getAttribute('href') ?? ''
    expect(exportHref).toBe('/api/audit-log/export?role=pharmacy&from=2026-09-01')
    expect(screen.getByLabelText('Role')).toHaveValue('pharmacy')
  })

  it('shows a message and lists nothing when a filter is not valid', async () => {
    const { AuditLogPage, listImpl } = await loadPage('admin')
    const jsx = await AuditLogPage({ searchParams: sp({ role: 'superuser' }) })
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(listImpl).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('Check the filters')
  })
})
