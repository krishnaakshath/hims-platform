import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopBanner } from '@/components/TopBanner'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], unreadCount: 0 }), { status: 200 }))) })
afterEach(() => { vi.unstubAllGlobals() })

describe('TopBanner', () => {
  // The logo/product name moved into LeftNav so the whole app shell reads
  // as "logo in the sidebar", matching the pattern requested for the
  // patient portal too -- TopBanner is now identity/actions only (search,
  // notifications, signed-in user, sign out).
  it('shows the signed-in user name', () => {
    render(<TopBanner userName="Jamie Ruiz" role="crc" />)
    expect(screen.getByText('Jamie Ruiz')).toBeInTheDocument()
  })

  // Wave G P2-01: the bell is every role's own feed (no longer the admin audit log).
  it.each(['admin', 'crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector'] as const)('shows the notification bell for %s', (role) => {
    render(<TopBanner userName="Test User" role={role} />)
    expect(screen.getByRole('button', { name: /^notifications/i })).toBeInTheDocument()
  })

  it.each(['pharmacy', 'labs', 'coder', 'collector'] as const)('hides the search box for %s', (role) => {
    render(<TopBanner userName="Jamie Ruiz" role={role} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it.each(['admin', 'crc', 'pi', 'frontdesk', 'billing'] as const)('shows the search box for %s', (role) => {
    render(<TopBanner userName="Jamie Ruiz" role={role} />)
    expect(screen.getByRole('combobox', { name: /search/i })).toBeInTheDocument()
  })

  // Wave B P1-24: the placeholder only names what the role can find.
  it.each([
    ['frontdesk', /^search patients by name, uhid or mobile/i],
    ['billing', /^search services/i],
  ] as const)('gives %s a role-specific placeholder', (role, re) => {
    render(<TopBanner userName="Jamie Ruiz" role={role} />)
    expect(screen.getByRole('combobox', { name: /search/i }).getAttribute('placeholder')).toMatch(re)
  })

  // Wave B P1-01: every role reaches its own account page from the top bar.
  it.each(['admin', 'crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs'] as const)('links %s to My account', (role) => {
    render(<TopBanner userName="Jamie Ruiz" role={role} />)
    expect(screen.getByRole('link', { name: /my account/i })).toHaveAttribute('href', '/account')
  })
})
