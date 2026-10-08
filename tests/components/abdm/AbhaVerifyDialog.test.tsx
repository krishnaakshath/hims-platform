import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AbhaVerifyButton, AbhaVerifyDialog, type AbdmStatus } from '@/components/abdm/AbhaVerifyDialog'

const STATUS: AbdmStatus = {
  state: 'mock', label: 'Sandbox mock - not real',
  enrolment: { text: 'SANDBOX MOCK CONSENT - not the NHA text\nSecond line.', sha256: 'e'.repeat(64) },
  verification: { text: 'I agree to verify.', sha256: 'v'.repeat(64) },
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => vi.unstubAllGlobals())

function openEnrolment() {
  const onVerified = vi.fn()
  render(<AbhaVerifyDialog patientId={null} mode="register" status={STATUS} onVerified={onVerified} onClose={() => {}} />)
  fireEvent.click(screen.getByLabelText('Create a new ABHA with Aadhaar OTP'))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  return onVerified
}

describe('AbhaVerifyDialog', () => {
  it('shows the consent text verbatim and blocks the Aadhaar step until consent', async () => {
    openEnrolment()
    expect(screen.getByTestId('abha-consent-text').textContent).toBe(STATUS.enrolment!.text)
    expect(screen.queryByLabelText('Aadhaar number')).toBeNull()
    expect(screen.getByRole('button', { name: 'Record consent' })).toBeDisabled()
    expect(screen.getByText('Sandbox mock - not real')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Patient agrees'))
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-1', consentId: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }))
    await screen.findByLabelText('Aadhaar number')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/abdm/abha/consent')
    expect(JSON.parse(init.body)).toEqual({ purpose: 'abha_enrolment', givenBy: 'patient', textSha256: STATUS.enrolment!.sha256 })
  })

  it('clears the Aadhaar field after the OTP request', async () => {
    openEnrolment()
    fireEvent.click(screen.getByLabelText('Patient agrees'))
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-1', consentId: 1 }))
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }))
    const input = await screen.findByLabelText('Aadhaar number')
    expect(input).toHaveAttribute('type', 'password'); expect(input).toHaveAttribute('autocomplete', 'off'); expect(input).toHaveAttribute('inputmode', 'numeric')
    fireEvent.change(input, { target: { value: '2341 2341 2346' } })
    expect((input as HTMLInputElement).value).toBe('234123412346')
    fetchMock.mockResolvedValueOnce(json(400, { error: 'Enter a valid 12-digit Aadhaar number' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send OTP' }))
    await screen.findByText('Enter a valid 12-digit Aadhaar number')
    expect((screen.getByLabelText('Aadhaar number') as HTMLInputElement).value).toBe('')
    expect(document.body.innerHTML).not.toContain('234123412346')
  })

  it('walks a mobile login through the account choice to the confirmation', async () => {
    const onVerified = vi.fn()
    render(<AbhaVerifyDialog patientId={null} mode="register" status={STATUS} onVerified={onVerified} onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText('Verify by mobile number'))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByLabelText('Patient agrees'))
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-2', consentId: 2 }))
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }))
    fireEvent.change(await screen.findByLabelText('Mobile number'), { target: { value: '9876500903' } })
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-2', step: 'otp_sent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send OTP' }))
    fireEvent.change(await screen.findByLabelText('OTP'), { target: { value: '123456' } })
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-2', step: 'choose_account', accounts: [{ abhaNumber: 'XX-XXXX-XXXX-3333', name: 'Asha' }] }))
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-2', step: 'verified', profile: { name: 'Asha', gender: 'F', yearOfBirth: 1990, abhaNumber: '91-1111-2222-3333', abhaAddress: 'asha@sbx' } }))
    fireEvent.click(await screen.findByRole('button', { name: /XX-XXXX-XXXX-3333/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Use this ABHA' }))
    expect(onVerified).toHaveBeenCalledWith({ abhaNumber: '91-1111-2222-3333', abhaAddress: 'asha@sbx', flowId: 'f-2' })
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ flowId: 'f-2', accountIndex: 0 })
  })
})

describe('AbhaVerifyButton', () => {
  it('is disabled with the title "ABDM not connected" when ABDM is not configured', async () => {
    fetchMock.mockResolvedValue(json(503, { error: 'ABDM is not configured' }))
    render(<AbhaVerifyButton patientId={null} mode="register" label="Create or verify with ABDM" onVerified={() => {}} />)
    const b = screen.getByRole('button', { name: /Create or verify with ABDM/ })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(b).toBeDisabled(); expect(b).toHaveAttribute('title', 'ABDM not connected')
  })
  it('is enabled and shows the mock label when the mock is on', async () => {
    fetchMock.mockResolvedValue(json(200, STATUS))
    render(<AbhaVerifyButton patientId={null} mode="register" label="Create or verify with ABDM" onVerified={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Create or verify with ABDM/ })).toBeEnabled())
    expect(screen.getByText('Sandbox mock - not real')).toBeInTheDocument()
  })
})
