import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { LeftNav } from '@/components/LeftNav'

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
    for (const role of ['frontdesk', 'pharmacy', 'billing', 'labs', 'coder'] as const) {
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
    for (const role of ['pharmacy', 'billing', 'labs', 'coder'] as const) {
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
    for (const role of ['billing', 'pharmacy', 'labs', 'coder'] as const) {
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
  it('shows the decline pill on Assignments for frontdesk', () => {
    render(<LeftNav role="frontdesk" badges={{ '/front-desk/assignments': 2 }} />)
    expect(within(screen.getByRole('link', { name: /assignments/i })).getByText('2')).toBeInTheDocument()
  })

  // SP6: Coding (CODING_ROLES) -- the coder sees only Home and Coding, nothing clinical.
  it('shows Coding to coder and admin only, and nothing clinical to a coder', () => {
    const { unmount } = render(<LeftNav role="coder" />)
    expect(screen.getByRole('link', { name: /^coding$/i })).toHaveAttribute('href', '/coding')
    expect(screen.queryByRole('link', { name: /patients/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /code systems/i })).not.toBeInTheDocument()
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/', '/coding'])
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
})
