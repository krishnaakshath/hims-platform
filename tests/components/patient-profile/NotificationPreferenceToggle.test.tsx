import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import { NotificationPreferenceToggle } from '@/components/patient-profile/NotificationPreferenceToggle'
import { PatientProfilePanel, type ProfileView } from '@/components/patient-profile/PatientProfilePanel'

afterEach(() => vi.unstubAllGlobals())

const patient: ProfileView = {
  id: 'RD-0001', uhid: null, gender: null, maritalStatus: null, bloodGroup: null, occupation: null, nationality: null, religion: null,
  preferredLanguage: null, addressLine1: null, addressLine2: null, city: null, district: null, stateCode: null, pinCode: null, phone: null,
  email: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: null, isMlc: false, mlcNumber: null, contacts: [], notificationOptOut: true,
}
const aadhaar = { status: 'not_recorded' as const, masked: null, declineReason: null }

describe('NotificationPreferenceToggle', () => {
  it('turns notices off and shows the new state', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ optOut: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<NotificationPreferenceToggle anonId="RD-0001" initialOptOut={false} />)
    const toggle = screen.getByRole('switch', { name: /send lab and home-collection notices/i })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'))
    expect(fetchMock).toHaveBeenCalledWith('/api/patients/RD-0001/notification-preference', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ optOut: true }) }))
  })

  it('keeps the old state and announces a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 500 })))
    render(<NotificationPreferenceToggle anonId="RD-0001" initialOptOut />)
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong on our side. Please try again.'))
    expect(toggle).toHaveAttribute('aria-checked', 'false')
  })
})

describe('PatientProfilePanel notifications', () => {
  it('renders the toggle only when canEditNotifications', () => {
    const { unmount } = render(<PatientProfilePanel patient={patient} aadhaar={aadhaar as never} canEdit={false} canWriteAadhaar={false} canEditNotifications />)
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    unmount()
    render(<PatientProfilePanel patient={patient} aadhaar={aadhaar as never} canEdit={false} canWriteAadhaar={false} />)
    expect(screen.queryByRole('switch')).toBeNull()
  })
})
