import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { Role } from '@/lib/auth'

// Task 8 (RBAC hardening): the staff directory is viewable by admin/crc/pi,
// but only admin gets write controls; pi must receive no write-capable props
// (no users/providers option lists for the Add modal). Denied roles redirect
// before any query. All query modules are mocked -- no DB or Redis access.

afterEach(() => cleanup())

const STAFF = [{ id: 5, userId: null, providerId: null, name: 'Sam Staffer', department: 'Nursing', title: 'RN', employmentStatus: 'active' as const, hireDate: '2020-01-02', terminationDate: null }]
const DETAIL = { ...STAFF[0], credentials: [{ id: 9, staffMemberId: 5, credentialType: 'RN Licence', credentialNumber: 'LIC-12345', expiresOn: '2030-01-01' }] }

function mockCommon(role: Role) {
  const spies = {
    redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) }),
    listStaffMembers: vi.fn(async () => STAFF),
    listExpiring: vi.fn(async () => []),
    listAllUsers: vi.fn(async () => [{ id: 1, name: 'U', email: 'secret@example.test', role: 'admin', mfaEnabled: true }]),
    listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr P' }]),
    getStaffMemberDetail: vi.fn(async () => DETAIL),
    getUserNameById: vi.fn(async () => null),
    listAllProviders: vi.fn(async () => []),
    getDb: vi.fn(() => { throw new Error('DB_BLOCKED') }),
  }
  vi.resetModules()
  vi.doUnmock('@/components/StaffDirectoryList')
  vi.doMock('next/navigation', () => ({
    redirect: spies.redirect,
    notFound: () => { throw new Error('NEXT_NOT_FOUND') },
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}`, userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/db/client', () => ({ getDb: spies.getDb }))
  vi.doMock('@/lib/queries/staff-members', () => ({ listStaffMembers: spies.listStaffMembers, getStaffMemberDetail: spies.getStaffMemberDetail }))
  vi.doMock('@/lib/queries/staff-credentials', () => ({ listExpiringOrExpiredCredentials: spies.listExpiring }))
  vi.doMock('@/lib/queries/users', () => ({ listAllUsers: spies.listAllUsers, getUserNameById: spies.getUserNameById }))
  vi.doMock('@/lib/queries/providers', () => ({ listActiveProviders: spies.listActiveProviders, listAllProviders: spies.listAllProviders }))
  return spies
}

async function renderList(role: Role) {
  const spies = mockCommon(role)
  const { default: Page } = await import('@/app/(dashboard)/staff/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page())
  return { spies, screen }
}

async function renderDetail(role: Role) {
  const spies = mockCommon(role)
  const { default: Page } = await import('@/app/(dashboard)/staff/[id]/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page({ params: Promise.resolve({ id: '5' }) }))
  return { spies, screen }
}

describe('/staff list', () => {
  it('pi sees the directory but no Add button, and no user/provider lists are queried or passed', async () => {
    const { spies, screen } = await renderList('pi')
    expect(screen.getByText('Sam Staffer')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(spies.listAllUsers).not.toHaveBeenCalled()
    expect(spies.listActiveProviders).not.toHaveBeenCalled()
  })

  it('pi passes canWrite=false and empty users/providers to the client component', async () => {
    const spies = mockCommon('pi')
    const captured: Record<string, unknown>[] = []
    vi.doMock('@/components/StaffDirectoryList', () => ({ StaffDirectoryList: (p: Record<string, unknown>) => { captured.push(p); return null } }))
    const { default: Page } = await import('@/app/(dashboard)/staff/page')
    const { render } = await import('@testing-library/react')
    render(await Page())
    expect(captured[0]).toMatchObject({ canWrite: false, users: [], providers: [] })
    expect(spies.listAllUsers).not.toHaveBeenCalled()
  })

  it.each(['admin', 'crc'] as const)('%s keeps working; only admin has the Add button', async (role) => {
    const { screen } = await renderList(role)
    expect(screen.getByText('Sam Staffer')).toBeInTheDocument()
    const add = screen.queryByRole('button', { name: 'Add Staff Member' })
    if (role === 'admin') expect(add).toBeInTheDocument()
    else expect(add).not.toBeInTheDocument()
  })

  it.each(['frontdesk', 'pharmacy', 'billing', 'labs', 'collector'] as const)('%s redirects to / before any query', async (role) => {
    const spies = mockCommon(role)
    const { default: Page } = await import('@/app/(dashboard)/staff/page')
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT:/')
    expect(spies.listStaffMembers).not.toHaveBeenCalled()
    expect(spies.listAllUsers).not.toHaveBeenCalled()
    expect(spies.getDb).not.toHaveBeenCalled()
  })
})

describe('/staff/[id] detail', () => {
  it('pi sees the credentials read-only: no Edit or Add Credential controls', async () => {
    const { screen } = await renderDetail('pi')
    expect(screen.getByText('Sam Staffer')).toBeInTheDocument()
    expect(screen.getByText('LIC-12345')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('crc is read-only; admin has Edit and Add Credential', async () => {
    const crc = await renderDetail('crc')
    expect(crc.screen.queryByRole('button')).not.toBeInTheDocument()
    cleanup()
    const admin = await renderDetail('admin')
    expect(admin.screen.getByRole('button', { name: 'Add Credential' })).toBeInTheDocument()
    expect(admin.screen.getAllByRole('button', { name: 'Edit' }).length).toBeGreaterThan(0)
  })

  it.each(['frontdesk', 'pharmacy', 'billing', 'labs', 'collector'] as const)('%s redirects to / before params or any query', async (role) => {
    const spies = mockCommon(role)
    const { default: Page } = await import('@/app/(dashboard)/staff/[id]/page')
    const params = new Proxy({}, { get() { throw new Error('PARAMS_TOUCHED') } }) as Promise<{ id: string }>
    await expect(Page({ params })).rejects.toThrow('NEXT_REDIRECT:/')
    expect(spies.getStaffMemberDetail).not.toHaveBeenCalled()
    expect(spies.getDb).not.toHaveBeenCalled()
  })
})
