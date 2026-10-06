import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PatientPortalSideNav } from '@/components/PatientPortalSideNav'

vi.mock('next/navigation', () => ({ usePathname: () => '/patient-portal/messages' }))

describe('PatientPortalSideNav', () => {
  it('renders the brand wordmark instead of any logo image', () => {
    render(<PatientPortalSideNav />)
    expect(screen.getByText('HIMS')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('gives the active nav link a filled rounded-full pill background, not a left border bar', () => {
    render(<PatientPortalSideNav />)
    const activeLink = screen.getByRole('link', { name: /messages/i, current: 'page' })
    expect(activeLink.className).toMatch(/rounded-full/)
    expect(activeLink.className).not.toMatch(/border-l-2/)
  })
})
