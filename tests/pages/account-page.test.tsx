import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Role } from '@/lib/auth'
import { ALL_ROLES } from '@/lib/role-policy'
import { ROLE_CAPABILITIES } from '@/lib/role-capabilities'

let role: Role = 'labs'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: `Test ${role}`, userId: 7 })) }))
vi.mock('next/navigation', () => ({
  redirect: (p: string) => { throw new Error(`REDIRECT ${p}`) },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/lib/queries/own-account', () => ({
  getOwnAccount: vi.fn(async () => ({ email: 'me@example.test', mfaMethod: 'sms', phone: '+919876543210' })),
}))

import AccountPage from '@/app/(dashboard)/account/page'
import { getOwnAccount } from '@/lib/queries/own-account'

beforeEach(() => { vi.clearAllMocks() })

// Wave B P1-01: every staff role can manage its own MFA and read what it can do.
describe('/account', () => {
  it.each([...ALL_ROLES])('renders the account panel for %s', async (r) => {
    role = r
    render(await AccountPage())
    expect(screen.getByRole('heading', { level: 1, name: /my account/i })).toBeInTheDocument()
    expect(screen.getByText(ROLE_CAPABILITIES[r].summary)).toBeInTheDocument()
    expect(screen.getByText(ROLE_CAPABILITIES[r].label)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /two-factor/i })).toBeInTheDocument()
  })

  it('resolves the account from the session (not from a form value)', async () => {
    role = 'billing'
    render(await AccountPage())
    expect(vi.mocked(getOwnAccount)).toHaveBeenCalledWith(expect.objectContaining({ role: 'billing', userId: 7 }))
  })
})
