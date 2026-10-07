import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

import { PatientProfilePanel, type ProfileView } from '@/components/patient-profile/PatientProfilePanel'

const patient: ProfileView = {
  id: 'RD-0001', uhid: 'UH-000001', gender: 'female', maritalStatus: null, bloodGroup: null, occupation: null,
  nationality: 'IN', religion: null, preferredLanguage: null, addressLine1: '12 MG Road', addressLine2: null, city: 'Pune',
  district: 'Pune', stateCode: 'IN-MH', pinCode: '411001', phone: null, email: null,
  abhaNumber: null, abhaAddress: null, abhaUnavailableReason: null, isMlc: false, mlcNumber: null, contacts: [],
}

beforeEach(() => { refresh.mockReset(); vi.unstubAllGlobals() })

describe('EditPatientProfileModal', () => {
  it('PATCHes /profile with changed address and refreshes; contacts untouched so no PUT', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PatientProfilePanel patient={patient} aadhaar={{ status: 'not_recorded', masked: null, declineReason: null }} canEdit canWriteAadhaar={false} />)
    fireEvent.click(screen.getByRole('button', { name: /edit profile/i }))
    fireEvent.change(await screen.findByLabelText('City'), { target: { value: 'Mumbai' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patients/RD-0001/profile')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toMatchObject({ city: 'Mumbai', stateCode: 'IN-MH' })
  })

  it('PUTs /contacts when contacts changed', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PatientProfilePanel patient={patient} aadhaar={{ status: 'not_recorded', masked: null, declineReason: null }} canEdit canWriteAadhaar={false} />)
    fireEvent.click(screen.getByRole('button', { name: /edit profile/i }))
    fireEvent.click(await screen.findByRole('button', { name: /add contact/i }))
    fireEvent.change(screen.getByLabelText(/contact 1 name/i), { target: { value: 'Ravi' } })
    fireEvent.change(screen.getByLabelText(/contact 1 relationship/i), { target: { value: 'spouse' } })
    fireEvent.change(screen.getByLabelText(/contact 1 phone/i), { target: { value: '9811111111' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const put = calls.find(([u]) => u.endsWith('/contacts'))!
    expect(put[1].method).toBe('PUT')
    expect(JSON.parse(put[1].body as string).contacts[0]).toMatchObject({ kind: 'next_of_kin', name: 'Ravi', relationship: 'spouse', phone: '9811111111' })
  })

  it('shows the server error and does not refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This ABHA number is already registered to another patient' }), { status: 409 })))
    render(<PatientProfilePanel patient={patient} aadhaar={{ status: 'not_recorded', masked: null, declineReason: null }} canEdit canWriteAadhaar={false} />)
    fireEvent.click(screen.getByRole('button', { name: /edit profile/i }))
    fireEvent.change(await screen.findByLabelText('City'), { target: { value: 'Mumbai' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText(/already registered/)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})
