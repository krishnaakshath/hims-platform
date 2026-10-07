import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TopBanner } from '@/components/TopBanner'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

describe('TopBanner', () => {
  // The logo/product name moved into LeftNav so the whole app shell reads
  // as "logo in the sidebar", matching the pattern requested for the
  // patient portal too -- TopBanner is now identity/actions only (search,
  // notifications, signed-in user, sign out).
  it('shows the signed-in user name', () => {
    render(<TopBanner userName="Jamie Ruiz" role="crc" />)
    expect(screen.getByText('Jamie Ruiz')).toBeInTheDocument()
  })

  it('hides the notification bell for a non-admin role', () => {
    render(<TopBanner userName="Jamie Ruiz" role="crc" />)
    expect(screen.queryByLabelText('Notifications')).not.toBeInTheDocument()
  })

  it('shows the notification bell for an admin role', () => {
    render(<TopBanner userName="Test Admin" role="admin" />)
    expect(screen.getByLabelText('Notifications')).toBeInTheDocument()
  })

  it.each(['billing', 'pharmacy', 'labs'] as const)('hides the search box for %s', (role) => {
    render(<TopBanner userName="Jamie Ruiz" role={role} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it.each(['admin', 'crc', 'pi', 'frontdesk'] as const)('shows the search box for %s', (role) => {
    render(<TopBanner userName="Jamie Ruiz" role={role} />)
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  // Wave B P1-01: every role reaches its own account page from the top bar.
  it.each(['admin', 'crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs'] as const)('links %s to My account', (role) => {
    render(<TopBanner userName="Jamie Ruiz" role={role} />)
    expect(screen.getByRole('link', { name: /my account/i })).toHaveAttribute('href', '/account')
  })
})
