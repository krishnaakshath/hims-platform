import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { LeftNav, NAV_BILLING_ITEMS } from '@/components/LeftNav'

vi.mock('next/navigation', () => ({ usePathname: () => '/patients' }))

describe('LeftNav', () => {
  it('renders the brand wordmark instead of any logo image', () => {
    render(<LeftNav role="admin" />)
    expect(screen.getByText('HIMS')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('gives the active nav link a filled rounded-full pill background, not a left border bar', () => {
    render(<LeftNav role="admin" />)
    const activeLink = screen.getByRole('link', { name: /patients/i, current: 'page' })
    expect(activeLink.className).toMatch(/rounded-md/)
    expect(activeLink.className).not.toMatch(/border-l-2/)
  })

  it('shows Check-In and Assignments for frontdesk, but hides admin/crc-only items', () => {
    render(<LeftNav role="frontdesk" />)
    expect(screen.getByRole('link', { name: /check-in/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /assignments/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /workbook/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /form templates/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /consent documents/i })).not.toBeInTheDocument()
  })

  it('hides non-clinical Admin menus from a pi', () => {
    render(<LeftNav role="pi" />)
    expect(screen.getByRole('link', { name: /my patients/i })).toBeInTheDocument()
    // ^documents$ -- "Consent Documents" is deliberately visible to a pi (see below).
    for (const hidden of [/identity matching/i, /reports/i, /broadcasts/i, /experience surveys/i, /pipeline dashboard/i]) {
      expect(screen.queryByRole('link', { name: hidden })).not.toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: /billing/i })).not.toBeInTheDocument()
  })

  it('shows Staff to admin, crc and pi, not to frontdesk, pharmacy, billing or labs', () => {
    for (const role of ['admin', 'crc', 'pi'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.getByRole('link', { name: /^staff$/i })).toHaveAttribute('href', '/staff')
      unmount()
    }
    for (const role of ['frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.queryByRole('link', { name: /^staff$/i })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('shows Documents to admin, crc, pi and frontdesk, not to pharmacy, billing or labs', () => {
    for (const role of ['admin', 'crc', 'pi', 'frontdesk'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.getByRole('link', { name: /^documents$/i })).toHaveAttribute('href', '/documents')
      unmount()
    }
    for (const role of ['pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.queryByRole('link', { name: /^documents$/i })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('shows the forms hub (Form Templates and Consent Documents) to admin, crc and pi', () => {
    for (const role of ['admin', 'crc', 'pi'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.getByRole('link', { name: /form templates/i })).toHaveAttribute('href', '/forms')
      expect(screen.getByRole('link', { name: /consent documents/i })).toHaveAttribute('href', '/consent-documents')
      unmount()
    }
  })

  it('hides the forms hub from billing, pharmacy and labs', () => {
    for (const role of ['billing', 'pharmacy', 'labs', 'coder', 'collector', 'rcm'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.queryByRole('link', { name: /form templates/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /consent documents/i })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('shows a count pill on My Patients when badges["/doctor"] > 0', () => {
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    expect(within(screen.getByRole('link', { name: /my patients/i })).getByText('3')).toBeInTheDocument()
  })
  it('renders no pill for a 0 or missing badge', () => {
    render(<LeftNav role="pi" badges={{ '/doctor': 0 }} />)
    expect(screen.getByRole('link', { name: /my patients/i }).textContent).toBe('My Patients')
  })
  // Wave B P0-01: billing-only nav must reach its own home and Tariffs.
  it('gives billing a Billing Home link and the Tariffs link, but no clinical entries', () => {
    render(<LeftNav role="billing" />)
    expect(screen.getByRole('link', { name: /billing home/i })).toHaveAttribute('href', '/billing')
    expect(screen.getByRole('link', { name: /^tariffs$/i })).toHaveAttribute('href', '/tariffs')
    for (const hidden of [/^patients$/i, /^calendar$/i, /^labs$/i, /^settings$/i, /^reports$/i]) {
      expect(screen.queryByRole('link', { name: hidden })).not.toBeInTheDocument()
    }
  })

  it('lists Billing Home first in the billing group', () => {
    expect(NAV_BILLING_ITEMS[0]).toMatchObject({ href: '/billing', label: 'Billing Home' })
  })

  it.each(['admin', 'crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs'] as const)('shows My Account to %s', (role) => {
    render(<LeftNav role={role} />)
    expect(screen.getByRole('link', { name: /my account/i })).toHaveAttribute('href', '/account')
  })

  // Wave B P1-21: demo-only entries follow DEMO_FEATURES and say "Demo" when shown.
  it('hides demo entries when demo features are off', () => {
    const { unmount } = render(<LeftNav role="billing" demoFeatures={false} />)
    expect(screen.queryByRole('link', { name: /virtual card payment/i })).not.toBeInTheDocument()
    unmount()
    render(<LeftNav role="admin" demoFeatures={false} />)
    expect(screen.queryByRole('link', { name: /broadcasts/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /experience surveys/i })).not.toBeInTheDocument()
  })

  it('shows demo entries with a Demo label when demo features are on', () => {
    const { unmount } = render(<LeftNav role="billing" demoFeatures />)
    expect(screen.getByRole('link', { name: /virtual card payment.*demo/i })).toHaveAttribute('href', '/billing/pay')
    unmount()
    render(<LeftNav role="admin" demoFeatures />)
    expect(screen.getByRole('link', { name: /broadcasts.*demo/i })).toHaveAttribute('href', '/broadcasts')
    expect(screen.getByRole('link', { name: /experience surveys.*demo/i })).toHaveAttribute('href', '/experience-surveys')
  })

  it('shows Price Lookup to admin, billing, crc, frontdesk and rcm only', () => {
    for (const role of ['admin', 'billing', 'crc', 'frontdesk', 'rcm'] as const) { // SP7: + rcm (TARIFF_LOOKUP_ROLES)
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.getByRole('link', { name: /price lookup/i })).toHaveAttribute('href', '/price-lookup')
      unmount()
    }
    for (const role of ['pi', 'pharmacy', 'labs', 'coder'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.queryByRole('link', { name: /price lookup/i })).not.toBeInTheDocument()
      unmount()
    }
  })

  it('shows the unread-messages and pending-booking pills (Wave B P1-25)', () => {
    render(<LeftNav role="crc" badges={{ '/messages': 4, '/booking-requests': 2 }} />)
    expect(within(screen.getByRole('link', { name: /messages/i })).getByText('4')).toBeInTheDocument()
    expect(within(screen.getByRole('link', { name: /booking requests/i })).getByText('2')).toBeInTheDocument()
  })

  it('shows the decline pill on Assignments for frontdesk', () => {
    render(<LeftNav role="frontdesk" badges={{ '/front-desk/assignments': 2 }} />)
    expect(within(screen.getByRole('link', { name: /assignments/i })).getByText('2')).toBeInTheDocument()
  })

  // SP4: billing-only nav gets the role-listed entries that name billing explicitly.
  it('billing-only nav shows Cash Desk and Tariffs but not Home', () => {
    render(<LeftNav role="billing" />)
    expect(screen.getByRole('link', { name: /cash desk/i })).toHaveAttribute('href', '/cash-desk')
    expect(screen.getByRole('link', { name: /tariffs/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^home$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /patients/i })).not.toBeInTheDocument()
    for (const label of [/charge capture/i, /invoices/i, /rules & settings/i]) expect(screen.getByRole('link', { name: label })).toBeInTheDocument()
  })

  it('shows Cash Desk to frontdesk and crc, not to pi, pharmacy, labs or coder', () => {
    for (const role of ['frontdesk', 'crc', 'admin'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.getByRole('link', { name: /cash desk/i })).toBeInTheDocument()
      unmount()
    }
    for (const role of ['pi', 'pharmacy', 'labs', 'coder', 'rcm'] as const) {
      const { unmount } = render(<LeftNav role={role} />)
      expect(screen.queryByRole('link', { name: /cash desk/i })).not.toBeInTheDocument()
      unmount()
    }
  })

  // SP6: Coding (CODING_ROLES) -- the coder sees only Home and Coding, nothing clinical.
  it('shows Coding to coder and admin only, and nothing clinical to a coder', () => {
    const { unmount } = render(<LeftNav role="coder" />)
    expect(screen.getByRole('link', { name: /^coding$/i })).toHaveAttribute('href', '/coding')
    expect(screen.queryByRole('link', { name: /patients/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /code systems/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/', '/coding', '/account'])
    unmount()
    const admin = render(<LeftNav role="admin" />)
    expect(screen.getByRole('link', { name: /^coding$/i })).toBeInTheDocument()
    admin.unmount()
    for (const role of ['crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs'] as const) {
      const r = render(<LeftNav role={role} />)
      expect(screen.queryByRole('link', { name: /^coding$/i }), role).not.toBeInTheDocument()
      r.unmount()
    }
  })

  // SP7
  it('rcm sees RCM Dashboard and Claims, and no billing or clinical entries', () => {
    render(<LeftNav role="rcm" />)
    expect(screen.getByRole('link', { name: /rcm dashboard/i })).toHaveAttribute('href', '/rcm')
    expect(screen.getByRole('link', { name: /^claims$/i })).toHaveAttribute('href', '/rcm/claims')
    for (const label of [/charge capture/i, /invoices/i, /cash desk/i, /patients/i, /coding/i]) expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument()
  })
  // end SP7
})
