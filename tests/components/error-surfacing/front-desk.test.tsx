// Wave H P2-09: registration, profile, front-desk and pharmacy-lookup
// components surface failures in role="alert" with the fixed client message.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { CLIENT_ERROR_MESSAGES, fillAll, mockFetch, pickPatient } from './helpers'
import type { DoctorAssignmentRow } from '@/lib/queries/doctor-assignments'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'

const router = { refresh: vi.fn(), push: vi.fn() }
vi.mock('next/navigation', () => ({ useRouter: () => router }))
afterEach(() => { vi.unstubAllGlobals(); router.refresh.mockClear(); router.push.mockClear() })

import { AssignmentScheduleModalTrigger } from '@/components/AssignmentScheduleModal'
import { ConfirmBookingRequestModal } from '@/components/ConfirmBookingRequestModal'
import { DeclineBookingRequestModal } from '@/components/DeclineBookingRequestModal'
import { ConfirmEligibilityButton } from '@/components/ConfirmEligibilityButton'
import { NewEventModal } from '@/components/NewEventModal'
import { StartTelemedicineButton } from '@/components/StartTelemedicineButton'
import { PatientPortalAccessPanel } from '@/components/PatientPortalAccessPanel'
import { MessageComposer } from '@/components/MessageComposer'
import { InsuranceCardUpload } from '@/components/InsuranceCardUpload'
import { PharmacyPatientLookup } from '@/components/PharmacyPatientLookup'
import { AadhaarPanel } from '@/components/patient-profile/AadhaarPanel'
import { VerifyIdentityButton } from '@/components/patient-profile/VerifyIdentityButton'

const LEAK = 'ECONNRESET at pg pool'
const assignment = { id: 42, patientId: 'RD-0001', providerId: 1, visitType: 'outpatient', urgency: 'routine', reason: 'r', status: 'pending' } as unknown as DoctorAssignmentRow
const request = { id: 5, requesterName: 'Morgan', reason: 'Checkup', preferredProviderId: null, preferredDateRangeStart: '2026-11-01', preferredDateRangeEnd: '2026-11-10' } as unknown as BookingRequestRow

type Case = { name: string; ui: () => ReactElement; before?: () => void | Promise<void>; submit: RegExp }
const CASES: Case[] = [
  { name: 'AssignmentScheduleModal', ui: () => <AssignmentScheduleModalTrigger assignment={assignment} />, before: () => fireEvent.click(screen.getByText('Review')), submit: /^Schedule$/ },
  { name: 'ConfirmBookingRequestModal', ui: () => <ConfirmBookingRequestModal request={request} providers={[{ id: 1, name: 'Dr' }]} onClose={vi.fn()} />, before: pickPatient, submit: /^Confirm$/ },
  { name: 'DeclineBookingRequestModal', ui: () => <DeclineBookingRequestModal request={request} onClose={vi.fn()} />, submit: /^Decline$/ },
  { name: 'NewEventModal', ui: () => <NewEventModal providers={[{ id: 1, name: 'Dr' }]} defaultDate="2026-10-08" initialPatient={{ id: 'RD-0001', name: 'P', uhid: null }} onClose={vi.fn()} />, submit: /^Save$/ },
  { name: 'ConfirmEligibilityButton', ui: () => <ConfirmEligibilityButton anonId="RD-0001" />, submit: /confirm/i },
  { name: 'StartTelemedicineButton', ui: () => <StartTelemedicineButton appointmentId={3} />, submit: /start|telemedicine|video/i },
  { name: 'PatientPortalAccessPanel', ui: () => <PatientPortalAccessPanel anonId="RD-0001" initialConfigured={false} mfaEnabled={false} isAdmin />, submit: /Enable portal access/ },
  { name: 'VerifyIdentityButton', ui: () => <VerifyIdentityButton anonId="RD-0001" verified={false} />,
    before: () => { fireEvent.click(screen.getByRole('button', { name: /verify identity/i })); fireEvent.change(screen.getByLabelText(/id document/i), { target: { value: 'pan' } }) }, submit: /mark verified/i },
]

describe.each(CASES)('$name', (c) => {
  it('shows a 500 in an alert with the fixed message (no server text) and stays usable', async () => {
    mockFetch(500, { error: LEAK })
    render(c.ui())
    await c.before?.()
    await fillAll()
    const button = screen.getAllByRole('button', { name: c.submit }).at(-1)!
    expect(button).toBeEnabled()
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(alert).not.toHaveTextContent('ECONNRESET')
    await waitFor(() => expect(screen.getAllByRole('button', { name: c.submit }).at(-1)).toBeEnabled())
  })
})

// SP8: EligibilityCheckModal was deleted with the simulated eligibility check (NHCX eligibility replaces it).

describe('MessageComposer', () => {
  it('surfaces a failed send and posts only once for Enter + click', async () => {
    const fetchMock = mockFetch(500, { error: LEAK })
    render(<MessageComposer patientId="RD-0001" viewerRole="provider" />)
    const box = screen.getByPlaceholderText('Write a message…')
    fireEvent.change(box, { target: { value: 'Hello' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('AadhaarPanel', () => {
  it('shows a 500 with the fixed message', async () => {
    mockFetch(500, { error: LEAK })
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'not_recorded', masked: null, declineReason: null }} canWrite />)
    fireEvent.click(screen.getAllByRole('button')[0])
    fireEvent.change(screen.getByPlaceholderText('XXXX XXXX XXXX'), { target: { value: '234567890124' } })
    fireEvent.click(screen.getByLabelText(/consents to recording/i))
    fireEvent.click(screen.getByRole('button', { name: /^save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})

describe('InsuranceCardUpload', () => {
  it('shows a failed upload in an alert', async () => {
    mockFetch(500, { error: LEAK })
    const { container } = render(<InsuranceCardUpload anonId="RD-0001" side="front" hasImage={false} canWrite />)
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'card.png', { type: 'image/png' })] } })
    const upload = screen.queryByRole('button', { name: /upload/i })
    if (upload) fireEvent.click(upload)
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})

describe('PharmacyPatientLookup', () => {
  const roster = [{ id: 'RD-0001', name: 'Asha Rao', uhid: null, activeMedicationCount: 1 }] as never
  it('shows a failed lookup in an alert', async () => {
    mockFetch(500, { error: LEAK })
    render(<PharmacyPatientLookup medications={[]} roster={roster} />)
    fireEvent.click(screen.getByRole('button', { name: /Asha Rao/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
  it('says "No patient with that ID" for a plain 404', async () => {
    mockFetch(404, {})
    render(<PharmacyPatientLookup medications={[]} roster={roster} />)
    fireEvent.click(screen.getByRole('button', { name: /Asha Rao/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No patient with that ID')
  })
})
