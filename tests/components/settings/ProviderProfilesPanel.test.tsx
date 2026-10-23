import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

import { ProviderProfilesPanel, type ProviderRow } from '@/components/settings/ProviderProfilesPanel'
import { ToastProvider } from '@/components/ui/toast'

const base: ProviderRow = {
  id: 7, name: 'Dr A', credentials: 'MD', specialty: 'Cardiology', colorTag: 'chart-1', isActive: true,
  departmentId: null, registrationCouncil: null, registrationStateCode: null, registrationNumber: null, consultationFeePaise: 150000,
}
const departments = [{ id: 3, code: 'CARD', name: 'Cardiology', kind: 'clinical', isActive: true, createdAt: new Date() }] as never

beforeEach(() => { refresh.mockReset(); vi.unstubAllGlobals() })

describe('ProviderProfilesPanel', () => {
  it('shows the tariff-derived fee, not the stored one, and says where to set it', () => {
    render(<ProviderProfilesPanel providers={[{ ...base, tariffFeePaise: 60000 }]} departments={departments} isAdmin />)
    expect(screen.getByText(/₹600\.00/)).toBeInTheDocument()
    expect(screen.queryByText(/₹1,500\.00/)).toBeNull()
    fireEvent.click(screen.getByLabelText('Edit Dr A'))
    expect(screen.getByText(/Set in Tariffs/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Consultation fee (₹)')).toBeNull()
  })
  it('never sends a fee on save', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProviderProfilesPanel providers={[base]} departments={departments} isAdmin />)
    fireEvent.click(screen.getByLabelText('Edit Dr A'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).not.toHaveProperty('consultationFeePaise')
  })
  it('shows the state select only for SMC and sends council fields', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProviderProfilesPanel providers={[base]} departments={departments} isAdmin />)
    fireEvent.click(screen.getByLabelText('Edit Dr A'))
    expect(screen.queryByLabelText('Registration state')).toBeNull()
    fireEvent.change(screen.getByLabelText('Registration council'), { target: { value: 'smc' } })
    fireEvent.change(screen.getByLabelText('Registration state'), { target: { value: 'IN-MH' } })
    fireEvent.change(screen.getByLabelText('Registration number'), { target: { value: 'MMC/2011/12345' } })
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ registrationCouncil: 'smc', registrationStateCode: 'IN-MH', registrationNumber: 'MMC/2011/12345', departmentId: 3 })
  })
  it('sends the OPD room and the online-booking flag (WS6 T6)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProviderProfilesPanel providers={[{ ...base, opdRoom: null, portalBookable: true }]} departments={departments} isAdmin />)
    fireEvent.click(screen.getByLabelText('Edit Dr A'))
    fireEvent.change(screen.getByLabelText('OPD room'), { target: { value: ' OPD 3 ' } })
    fireEvent.click(screen.getByLabelText('Offered on online booking'))
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ opdRoom: 'OPD 3', portalBookable: false })
  })
  it('opens the working-hours panel for an admin only (WS6 T6)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ slotMinutes: 15, opdRoom: null, sessions: [], leave: [] }), { status: 200 })))
    const { unmount } = render(<ToastProvider><ProviderProfilesPanel providers={[base]} departments={departments} isAdmin /></ToastProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Working hours for Dr A' }))
    expect(await screen.findByRole('group', { name: 'Monday' })).toBeInTheDocument()
    unmount()
    render(<ProviderProfilesPanel providers={[base]} departments={departments} isAdmin={false} />)
    expect(screen.queryByRole('button', { name: 'Working hours for Dr A' })).toBeNull()
  })
})
