import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { row } from '../components/follow-ups/worklist-fixtures'

afterEach(() => cleanup())

const ROWS = [
  row({ id: 1, bucket: 'overdue', patientName: 'Asha Rao' }),
  row({ id: 2, bucket: 'overdue', patientName: 'Other Doc Patient', prescribedBy: { providerId: 9, name: 'Dr. M' } }),
  row({ id: 3, bucket: 'due', patientName: 'Due Patient' }),
]

async function renderAs(role: string, searchParams: Record<string, string> = {}, rows = ROWS, flags = { capped: false, missedCapped: false }) {
  vi.resetModules()
  const logAudit = vi.fn(async () => undefined)
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  const listFollowUpWorklist = vi.fn(async () => ({ rows, ...flags }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester' })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('@/lib/queries/follow-up-recall', () => ({ listFollowUpWorklist }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 7, name: 'Dr. K', email: 'secret@x.in' }]) }))
  vi.doMock('@/lib/queries/departments', () => ({ listDepartments: vi.fn(async () => [{ id: 2, name: 'Cardiology', code: 'C' }]) }))
  vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), redirect }))
  const { default: Page } = await import('@/app/(dashboard)/front-desk/follow-ups/page')
  const { render, screen } = await import('@testing-library/react')
  const jsx = await Page({ searchParams: Promise.resolve(searchParams) })
  const utils = render(jsx)
  return { screen, logAudit, listFollowUpWorklist, redirect, ...utils }
}

describe('/front-desk/follow-ups', () => {
  it('frontdesk sees bucket counts and action buttons', async () => {
    const { screen, logAudit } = await renderAs('frontdesk', { bucket: 'overdue' })
    expect(screen.getByRole('link', { name: 'Overdue (2)' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Due (1)' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /^book/i }).length).toBeGreaterThan(0)
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'viewed follow-up worklist', null)
  })

  it('crc sees the list without action buttons', async () => {
    const { screen } = await renderAs('crc', { bucket: 'overdue' })
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /book|log contact/i })).toBeNull()
  })

  it('passes filters from searchParams', async () => {
    const { screen, container } = await renderAs('admin', { bucket: 'overdue', providerId: '7' })
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.queryByText('Other Doc Patient')).toBeNull()
    expect(screen.queryByText('Due Patient')).toBeNull()
    expect(container.innerHTML).not.toMatch(/secret@x\.in/)
  })

  it('shows the cap notice when the query says it was capped (raw SQL count), not by counting rows', async () => {
    const { screen } = await renderAs('frontdesk', {}, ROWS, { capped: true, missedCapped: false })
    expect(screen.getByText(/showing first 500/i)).toBeInTheDocument()
    expect(screen.queryByText(/missed follow-ups \(most recent first\)/i)).toBeNull()
  })

  it('shows the separate missed cap notice on the missed tab', async () => {
    const { screen } = await renderAs('frontdesk', { bucket: 'missed' }, ROWS, { capped: false, missedCapped: true })
    expect(screen.getByText(/showing first 200 missed follow-ups/i)).toBeInTheDocument()
    expect(screen.queryByText(/showing first 500/i)).toBeNull()
  })

  it.each(['pi', 'billing', 'labs', 'coder', 'collector'])('redirects %s before any query', async (role) => {
    vi.resetModules()
    const listFollowUpWorklist = vi.fn(async () => ({ rows: [], capped: false, missedCapped: false }))
    const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
    vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T' })) }))
    vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn() }))
    vi.doMock('@/lib/queries/follow-up-recall', () => ({ listFollowUpWorklist }))
    vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => []) }))
    vi.doMock('@/lib/queries/departments', () => ({ listDepartments: vi.fn(async () => []) }))
    vi.doMock('next/navigation', () => ({ redirect }))
    const { default: Page } = await import('@/app/(dashboard)/front-desk/follow-ups/page')
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_REDIRECT')
    expect(listFollowUpWorklist).not.toHaveBeenCalled()
  })
})
