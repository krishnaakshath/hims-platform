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

describe('AbhaVerifyDialog identity check (WS12 T5)', () => {
  const PROFILE = { name: 'Sandbox Mock Patient', gender: null, yearOfBirth: null, abhaNumber: '91-1111-2222-3333', abhaAddress: 'mock@sbx' }
  const row = (field: string, result: string, chart: string | null, abdm: string | null) => ({ field, result, chart, abdm })
  const MISMATCH = {
    mismatch: true, mismatchedFields: ['name'],
    fields: [row('name', 'mismatch', 'Fathima Beevi', 'Sandbox Mock Patient'), row('dob', 'unavailable', '1979-05-02', null), row('gender', 'unavailable', 'female', null)],
  }
  const MATCH = {
    mismatch: false, mismatchedFields: [],
    fields: [row('name', 'match', 'Asha Rao', 'Asha Rao'), row('dob', 'match', '1990-03-12', '1990'), row('gender', 'match', 'female', 'female')],
  }

  async function reachConfirm(comparison: unknown) {
    const onVerified = vi.fn()
    render(<AbhaVerifyDialog patientId="RD-1" mode="profile" status={STATUS} onVerified={onVerified} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(screen.getByLabelText('Patient agrees'))
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-9', consentId: 9 }))
    fireEvent.click(screen.getByRole('button', { name: 'Record consent' }))
    fireEvent.change(await screen.findByLabelText('ABHA number'), { target: { value: '91-1111-2222-3333' } })
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-9', step: 'otp_sent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send OTP' }))
    fireEvent.change(await screen.findByLabelText('OTP'), { target: { value: '123456' } })
    fetchMock.mockResolvedValueOnce(json(200, { flowId: 'f-9', step: 'verified', profile: PROFILE, comparison }))
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await screen.findByRole('table', { name: 'Chart and ABHA profile' })
    return onVerified
  }

  it('shows the chart and ABHA side by side, highlights mismatches and needs a reason before "Link anyway"', async () => {
    const onVerified = await reachConfirm(MISMATCH)
    const rows = screen.getAllByRole('row').filter((r) => r.hasAttribute('data-result'))
    expect(rows.map((r) => r.getAttribute('data-result'))).toEqual(['mismatch', 'unavailable', 'unavailable'])
    expect(rows[0].textContent).toContain('Fathima Beevi'); expect(rows[0].textContent).toContain('Sandbox Mock Patient')
    expect(rows[0].className).toMatch(/bg-red/)
    expect(screen.getByRole('alert').textContent).toContain('The ABHA profile does not match this patient')
    expect(screen.queryByRole('button', { name: 'Link to this patient' })).toBeNull()
    const link = screen.getByRole('button', { name: 'Link anyway' })
    expect(link).toBeDisabled()
    const reason = screen.getByLabelText('Reason for linking anyway')
    fireEvent.change(reason, { target: { value: 'too short' } })
    expect(link).toBeDisabled()
    fireEvent.change(reason, { target: { value: 'Name changed after marriage' } })
    expect(link).toBeEnabled()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }))
    fireEvent.click(link)
    await waitFor(() => expect(onVerified).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[3]
    expect(url).toBe('/api/patients/RD-1/abha/link')
    expect(JSON.parse(init.body)).toEqual({ flowId: 'f-9', mismatchReason: 'Name changed after marriage' })
  })

  it('a full match keeps "Link to this patient" with no reason', async () => {
    const onVerified = await reachConfirm(MATCH)
    expect(screen.queryByLabelText('Reason for linking anyway')).toBeNull()
    fetchMock.mockResolvedValueOnce(json(200, { ok: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Link to this patient' }))
    await waitFor(() => expect(onVerified).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ flowId: 'f-9' })
  })

  it('a 409 identity_mismatch from the server switches the dialog to the reason step', async () => {
    await reachConfirm(MATCH)
    fetchMock.mockResolvedValueOnce(json(409, { error: 'The ABHA profile does not match this patient. Check the details, or give a reason to link anyway.', code: 'identity_mismatch', fields: ['dob'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Link to this patient' }))
    expect(await screen.findByLabelText('Reason for linking anyway')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Link anyway' })).toBeDisabled()
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
