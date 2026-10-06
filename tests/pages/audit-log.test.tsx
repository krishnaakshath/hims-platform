import { describe, it, expect, vi } from 'vitest'

const { mockRedirect } = vi.hoisted(() => ({ mockRedirect: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: mockRedirect }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/audit-log', () => ({
  listAuditLog: vi.fn(async () => [
    { id: 1, userName: 'Sam Patel', role: 'admin', action: 'viewed patient list', patientId: null, timestamp: new Date('2026-09-25T10:00:00Z'), details: null },
    { id: 2, userName: 'Jamie Ruiz', role: 'crc', action: 'deleted patient RD-0002', patientId: 'RD-0002', timestamp: new Date('2026-09-25T09:00:00Z'), details: null },
  ]),
}))

describe('Audit Log page (/audit-log)', () => {
  it('redirects a non-admin (CRC) session away instead of rendering', async () => {
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'crc', name: 'Test CRC' })) }))
    const { default: AuditLogPage } = await import('@/app/(dashboard)/audit-log/page')
    await AuditLogPage()
    expect(mockRedirect).toHaveBeenCalledWith('/')
  })

  it('redirects a non-admin (PI) session away instead of rendering', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({ redirect: mockRedirect }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'pi', name: 'Test PI' })) }))
    const { default: AuditLogPage } = await import('@/app/(dashboard)/audit-log/page')
    await AuditLogPage()
    expect(mockRedirect).toHaveBeenCalledWith('/')
  })

  it('renders entries for an admin session', async () => {
    vi.resetModules()
    vi.doMock('next/navigation', () => ({ redirect: mockRedirect }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Test Admin' })) }))
    vi.doMock('@/lib/queries/audit-log', () => ({
      listAuditLog: vi.fn(async () => [
        { id: 1, userName: 'Sam Patel', role: 'admin', action: 'viewed patient list', patientId: null, timestamp: new Date('2026-09-25T10:00:00Z'), details: null },
        { id: 2, userName: 'Jamie Ruiz', role: 'crc', action: 'deleted patient RD-0002', patientId: 'RD-0002', timestamp: new Date('2026-09-25T09:00:00Z'), details: null },
      ]),
    }))
    const { default: AuditLogPage } = await import('@/app/(dashboard)/audit-log/page')
    const jsx = await AuditLogPage()
    const { render, screen } = await import('@testing-library/react')
    render(jsx)
    expect(screen.getByText('Sam Patel')).toBeInTheDocument()
    expect(screen.getByText('Jamie Ruiz')).toBeInTheDocument()
    expect(screen.getByText('deleted patient RD-0002')).toBeInTheDocument()
    expect(screen.getByText('RD-0002')).toBeInTheDocument()
  })
})
