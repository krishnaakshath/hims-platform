// WS7 T7 (spec D13): patient MFA is offered, not required. The portal shell shows a nudge
// linking to Security until MFA is on; dismissing it hides it for this browser session only.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const h = vi.hoisted(() => ({ mfaEnabled: false }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND') }, redirect: () => { throw new Error('NEXT_REDIRECT') }, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/patient-session', () => ({ requirePatientSessionOrRedirect: vi.fn(async () => ({ patientId: 'RD-0001' })) }))
vi.mock('@/lib/queries/policy-documents', () => ({ hasAcceptedCurrentPolicies: vi.fn(async () => true) }))
vi.mock('@/lib/queries/patient-portal', () => ({
  getPatientPortalIdentity: vi.fn(async () => ({ id: 'RD-0001', name: 'Test Patient', dob: '1980-01-01', uhid: 'UH-0001' })),
  getPatientMfaState: vi.fn(async () => ({ mfaSecretEncrypted: null, mfaEnabled: h.mfaEnabled })),
}))
vi.mock('@/components/PatientPortalSideNav', () => ({ PatientPortalSideNav: () => <nav /> }))
vi.mock('@/components/PatientPortalTopBar', () => ({ PatientPortalTopBar: () => <header /> }))
vi.mock('@/components/PatientPortalSessionTimeoutWarning', () => ({ PatientPortalSessionTimeoutWarning: () => null }))

import PatientPortalLayout from '@/app/patient-portal/(authenticated)/layout'
import { MfaNudge } from '@/components/portal/MfaNudge'

beforeEach(() => {
  h.mfaEnabled = false
  sessionStorage.clear()
})

describe('portal MFA nudge', () => {
  it('shows a link to Security when MFA is off', async () => {
    render(await PatientPortalLayout({ children: <p>content</p> }))
    const nudge = screen.getByRole('note', { name: 'Two-factor authentication' })
    expect(nudge).toHaveTextContent(/recommended/i)
    expect(screen.getByRole('link', { name: /turn on two-factor/i })).toHaveAttribute('href', '/patient-portal/security')
  })

  it('is not shown when MFA is on', async () => {
    h.mfaEnabled = true
    render(await PatientPortalLayout({ children: <p>content</p> }))
    expect(screen.queryByRole('note', { name: 'Two-factor authentication' })).toBeNull()
    expect(screen.getByText('content')).toBeInTheDocument()
  })

  it('dismissal lasts for this browser session only', () => {
    const { unmount } = render(<MfaNudge dismissible />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('note')).toBeNull()
    unmount()
    const second = render(<MfaNudge dismissible />)
    expect(screen.queryByRole('note')).toBeNull()
    second.unmount()
    // A new sign-in (fresh session storage) shows it again.
    sessionStorage.clear()
    render(<MfaNudge dismissible />)
    expect(screen.getByRole('note', { name: 'Two-factor authentication' })).toBeInTheDocument()
  })

  it('without dismissible there is no Not now button', () => {
    render(<MfaNudge dismissible={false} />)
    expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
  })
})
