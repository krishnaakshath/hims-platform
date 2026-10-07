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
    expect(JSON.parse(init.body as string)).toEqual({ city: 'Mumbai' })
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

  const open = async (p: ProfileView = patient) => {
    render(<PatientProfilePanel patient={p} aadhaar={{ status: 'not_recorded', masked: null, declineReason: null }} canEdit canWriteAadhaar={false} />)
    fireEvent.click(screen.getByRole('button', { name: /edit profile/i }))
    await screen.findByLabelText('City')
  }
  const sentBody = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(((fetchMock.mock.calls[i] as unknown as [string, RequestInit])[1]).body as string)

  it('sends nothing and closes when nothing changed', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await open({ ...patient, phone: '+919876543210', nationality: null })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(screen.queryByLabelText('City')).toBeNull())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('clears an optional field by sending null', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await open({ ...patient, occupation: 'Teacher' })
    fireEvent.change(screen.getByLabelText('Occupation'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(sentBody(fetchMock)).toEqual({ occupation: null })
  })

  it('switches ABHA to unavailable with a reason', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await open({ ...patient, abhaNumber: '91123456789012', abhaAddress: null })
    fireEvent.click(screen.getByLabelText('ABHA not available'))
    fireEvent.change(screen.getByLabelText('Reason ABHA is not available'), { target: { value: 'patient_declined' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(sentBody(fetchMock)).toEqual({ abha: { status: 'unavailable', reason: 'patient_declined' } })
  })

  it('moves from unavailable back to provided with an address', async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await open({ ...patient, abhaUnavailableReason: 'not_created' })
    expect((screen.getByLabelText('ABHA not available') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByLabelText('ABHA not available'))
    fireEvent.change(screen.getByLabelText('ABHA address'), { target: { value: 'asha@abdm' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(sentBody(fetchMock)).toEqual({ abha: { status: 'provided', abhaAddress: 'asha@abdm' } })
  })

  it('requires a reason before marking ABHA unavailable', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await open()
    fireEvent.click(screen.getByLabelText('ABHA not available'))
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    expect(await screen.findByText(/select a reason/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  async function changeCityAndAddContact() {
    fireEvent.change(screen.getByLabelText('City'), { target: { value: 'Mumbai' } })
    fireEvent.click(screen.getByRole('button', { name: /add contact/i }))
    fireEvent.change(screen.getByLabelText(/contact 1 name/i), { target: { value: 'Ravi' } })
    fireEvent.change(screen.getByLabelText(/contact 1 relationship/i), { target: { value: 'spouse' } })
    fireEvent.change(screen.getByLabelText(/contact 1 phone/i), { target: { value: '9811111111' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
  }

  it('reports clearly when the profile saved but the contacts did not', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => u.endsWith('/contacts')
      ? new Response(JSON.stringify({ error: 'A guardian contact is required' }), { status: 400 })
      : new Response('{"ok":true}', { status: 200 })))
    await open()
    await changeCityAndAddContact()
    expect(await screen.findByText(/Profile changes were saved\. Contacts were not saved: A guardian contact is required/)).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it('reports clearly when the contacts saved but the profile did not, and a retry resends only the profile', async () => {
    let profileOk = false
    const fetchMock = vi.fn(async (u: string) => u.endsWith('/contacts')
      ? new Response('{"ok":true}', { status: 200 })
      : profileOk ? new Response('{"ok":true}', { status: 200 }) : new Response(JSON.stringify({ error: 'Invalid profile update' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)
    await open()
    await changeCityAndAddContact()
    expect(await screen.findByText(/Contacts were saved\. Profile changes were not saved: Invalid profile update/)).toBeInTheDocument()
    fetchMock.mockClear()
    profileOk = true
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['/api/patients/RD-0001/profile'])
  })

  it('says nothing was saved when both fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })))
    await open()
    await changeCityAndAddContact()
    expect(await screen.findByText(/Nothing was saved/)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})
