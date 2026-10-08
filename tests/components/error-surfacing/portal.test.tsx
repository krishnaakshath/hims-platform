// Wave H P2-09: patient-portal, intake and public booking components surface
// failures in role="alert"; sign-in style 401s keep the route's own wording.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CLIENT_ERROR_MESSAGES, fillAll, mockFetch, mockFetchReject } from './helpers'

const router = { refresh: vi.fn(), push: vi.fn() }
vi.mock('next/navigation', () => ({ useRouter: () => router }))
afterEach(() => { vi.unstubAllGlobals(); router.refresh.mockClear(); router.push.mockClear() })

import { PatientConsentForm } from '@/components/PatientConsentForm'
import { PatientPortalSecurityPanel } from '@/components/PatientPortalSecurityPanel'
import { PublicBookingForm } from '@/components/PublicBookingForm'
import { IntakePortalForm } from '@/components/IntakePortalForm'
import { StaffMfaSelfResetForm } from '@/components/settings/StaffMfaSelfResetForm'

const LEAK = 'Error: connect ECONNREFUSED 10.0.0.5:5432'

describe('PatientConsentForm', () => {
  it('shows a 500 with the fixed message and does not navigate', async () => {
    mockFetch(500, { error: LEAK })
    render(<PatientConsentForm nppBody="n" tosBody="t" />)
    fireEvent.click(screen.getByLabelText(/Notice of Privacy Practices/))
    fireEvent.click(screen.getByLabelText(/Terms of Service/))
    fireEvent.click(screen.getByRole('button', { name: 'Accept and continue' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(router.push).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Accept and continue' })).toBeEnabled()
  })
})

describe('PatientPortalSecurityPanel', () => {
  it('shows a failed enrollment start', async () => {
    mockFetchReject()
    render(<PatientPortalSecurityPanel initialMfaEnabled={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable two-factor authentication' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.network)
  })
  it('keeps the route\'s wording for a wrong password (401) on reset', async () => {
    mockFetch(401, { error: 'Incorrect password' })
    render(<PatientPortalSecurityPanel initialMfaEnabled />)
    fireEvent.click(screen.getByRole('button', { name: 'Turn off two-factor authentication' }))
    fireEvent.change(screen.getByLabelText('Confirm your password'), { target: { value: 'pw' } })
    fireEvent.submit(screen.getByLabelText('Confirm your password').closest('form')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect password')
  })
})

describe('StaffMfaSelfResetForm', () => {
  it('keeps the route\'s wording for a wrong password (401)', async () => {
    mockFetch(401, { error: 'Invalid email or password' })
    render(<StaffMfaSelfResetForm email="a@b.co" />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset my MFA' }))
    fireEvent.change(screen.getByLabelText('Confirm your password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reset MFA' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password')
  })
})

describe('PublicBookingForm', () => {
  it('shows a 500 with the fixed message', async () => {
    mockFetch(500, { error: LEAK })
    render(<PublicBookingForm providers={[{ id: 1, name: 'Dr A' }] as never} providerAppointmentCounts={{}} />)
    await fillAll()
    fireEvent.click(screen.getByRole('button', { name: 'Request appointment' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toContain('ECONNREFUSED')
  })
})

describe('IntakePortalForm', () => {
  it('shows a failed save with the fixed message', async () => {
    mockFetch(500, { error: LEAK })
    render(<IntakePortalForm token="tok" questions={[{ id: 'q1', label: 'Name', type: 'text', hipaaSensitive: false, required: false }] as never} existingAnswers={{}} autofill={{}} consents={[]} />)
    await fillAll()
    const save = screen.getAllByRole('button').find((b) => /save|submit/i.test(b.textContent ?? ''))!
    fireEvent.click(save)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})
