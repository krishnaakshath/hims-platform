import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

import { AadhaarPanel } from '@/components/patient-profile/AadhaarPanel'

beforeEach(() => { refresh.mockReset(); vi.unstubAllGlobals() })

describe('AadhaarPanel', () => {
  it('renders the masked value when given', () => {
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'on_file', masked: 'XXXX XXXX 0124', declineReason: null }} canWrite />)
    expect(screen.getByText('XXXX XXXX 0124')).toBeInTheDocument()
  })

  it('renders On file with no digits when masked is null', () => {
    const { container } = render(<AadhaarPanel anonId="RD-0001" view={{ status: 'on_file', masked: null, declineReason: null }} canWrite={false} />)
    expect(screen.getByText('On file')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/\d/)
  })

  it('shows the decline reason label, or Not recorded', () => {
    const { unmount } = render(<AadhaarPanel anonId="RD-0001" view={{ status: 'declined', masked: null, declineReason: 'patient_declined' }} canWrite={false} />)
    expect(screen.getByText(/Declined — Patient declined/)).toBeInTheDocument()
    unmount()
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'not_recorded', masked: null, declineReason: null }} canWrite={false} />)
    expect(screen.getByText('Not recorded')).toBeInTheDocument()
  })

  it('declined without a visible reason (frontdesk) shows just Declined', () => {
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'declined', masked: null, declineReason: null }} canWrite={false} />)
    expect(screen.getByText('Declined')).toBeInTheDocument()
  })

  it('hides Record Aadhaar when canWrite is false', () => {
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'not_recorded', masked: null, declineReason: null }} canWrite={false} />)
    expect(screen.queryByRole('button', { name: /record aadhaar/i })).not.toBeInTheDocument()
  })

  it('PUTs the number with consent and refreshes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'on_file' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'not_recorded', masked: null, declineReason: null }} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: /record aadhaar/i }))
    fireEvent.change(await screen.findByLabelText('Aadhaar number'), { target: { value: '2345 6789 0124' } })
    fireEvent.click(screen.getByLabelText(/consents/i))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patients/RD-0001/aadhaar')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ status: 'provided', number: '234567890124', consent: true })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('PUTs a decline with reason', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'not_recorded', masked: null, declineReason: null }} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: /record aadhaar/i }))
    fireEvent.click(await screen.findByLabelText(/does not provide/i))
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'emergency' } })
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual({ status: 'declined', reason: 'emergency' })
  })

  it('disables Save for reason other without a note and shows the field message', async () => {
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'not_recorded', masked: null, declineReason: null }} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: /record aadhaar/i }))
    fireEvent.click(await screen.findByLabelText(/does not provide/i))
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'other' } })
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.getByText('A note is required when the reason is other')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'lost card' } })
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  it('shows an error and does not refresh on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid Aadhaar update' }), { status: 400 })))
    render(<AadhaarPanel anonId="RD-0001" view={{ status: 'not_recorded', masked: null, declineReason: null }} canWrite />)
    fireEvent.click(screen.getByRole('button', { name: /record aadhaar/i }))
    fireEvent.change(await screen.findByLabelText('Aadhaar number'), { target: { value: '234567890124' } })
    fireEvent.click(screen.getByLabelText(/consents/i))
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Invalid Aadhaar update/)
    expect(refresh).not.toHaveBeenCalled()
  })
})
