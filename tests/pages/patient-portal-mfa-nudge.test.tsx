// WS7 T7 (spec D13): patient MFA is offered, not required. The portal shell shows a nudge
// linking to Security until MFA is on; dismissing it hides it for this browser session only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

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

import PatientPortalLayout from '@/app/patient-portal/(authenticated)/layout'
import { MfaNudge } from '@/components/portal/MfaNudge'
import { PatientPortalSignOutButton } from '@/components/PatientPortalSignOutButton'
import { PatientPortalSessionTimeoutWarning } from '@/components/PatientPortalSessionTimeoutWarning'

const DISMISS_KEY = 'hims.portal.mfaNudgeDismissed'

beforeEach(() => {
  h.mfaEnabled = false
  sessionStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

// Review round 1: a dismissal must not carry over to the next patient signing in on this tab.
describe('signing out forgets the nudge dismissal', () => {
  it('the Sign out button clears it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    render(<MfaNudge dismissible />)
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(sessionStorage.getItem(DISMISS_KEY)).toBe('1')
    render(<PatientPortalSignOutButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(sessionStorage.getItem(DISMISS_KEY)).toBeNull())
  })

  it('the inactivity sign-out clears it', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    sessionStorage.setItem(DISMISS_KEY, '1')
    render(<PatientPortalSessionTimeoutWarning />)
    await act(async () => { vi.advanceTimersByTime(12 * 60 * 1000 + 1) })
    expect(sessionStorage.getItem(DISMISS_KEY)).toBeNull()
  })
})
