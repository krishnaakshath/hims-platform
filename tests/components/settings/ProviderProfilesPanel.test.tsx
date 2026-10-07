import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

import { ProviderProfilesPanel, type ProviderRow } from '@/components/settings/ProviderProfilesPanel'

const base: ProviderRow = {
  id: 7, name: 'Dr A', credentials: 'MD', specialty: 'Cardiology', colorTag: 'chart-1', isActive: true,
  departmentId: null, registrationCouncil: null, registrationStateCode: null, registrationNumber: null, consultationFeePaise: 150000,
}
const departments = [{ id: 3, code: 'CARD', name: 'Cardiology', kind: 'clinical', isActive: true, createdAt: new Date() }] as never

beforeEach(() => { refresh.mockReset(); vi.unstubAllGlobals() })

describe('ProviderProfilesPanel', () => {
  it('shows the fee as rupees', () => {
    render(<ProviderProfilesPanel providers={[base]} departments={departments} isAdmin />)
    expect(screen.getByText(/₹1,500\.00/)).toBeInTheDocument()
  })
  it('converts rupee input to paise on save', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ProviderProfilesPanel providers={[base]} departments={departments} isAdmin />)
    fireEvent.click(screen.getByLabelText('Edit Dr A'))
    fireEvent.change(screen.getByLabelText('Consultation fee (₹)'), { target: { value: '500' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/providers/7')
    expect(JSON.parse(init.body as string).consultationFeePaise).toBe(50000)
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
  it('rejects an invalid rupee amount without calling the API', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<ProviderProfilesPanel providers={[base]} departments={departments} isAdmin />)
    fireEvent.click(screen.getByLabelText('Edit Dr A'))
    fireEvent.change(screen.getByLabelText('Consultation fee (₹)'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByText('Save'))
    expect(await screen.findByText(/valid fee/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
