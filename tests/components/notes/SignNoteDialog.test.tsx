import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SignNoteDialog } from '@/components/notes/SignNoteDialog'

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>

function mockFetch(status = 200, body: unknown = { ok: true }): FetchMock {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const signButton = () => screen.getByRole('button', { name: 'Sign note' })

describe('SignNoteDialog', () => {
  it('disables Sign until the name, the attestation tick and the password are all present', () => {
    mockFetch()
    render(<SignNoteDialog patientId="P1" noteId={5} reauthMethod="password" onClose={vi.fn()} onSigned={vi.fn()} />)
    expect(screen.getByText('I confirm I wrote or reviewed this note and that it is accurate.')).toBeTruthy()
    expect(signButton()).toHaveProperty('disabled', true)

    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Dr. R. Kunam' } })
    expect(signButton()).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByLabelText('Attestation'))
    expect(signButton()).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
    expect(signButton()).toHaveProperty('disabled', false)

    fireEvent.click(screen.getByLabelText('Attestation'))
    expect(signButton()).toHaveProperty('disabled', true)
  })

  it('sends the typed name, attestation and password, then reports success', async () => {
    const fetchMock = mockFetch()
    const onSigned = vi.fn()
    render(<SignNoteDialog patientId="P1" noteId={5} reauthMethod="password" onClose={vi.fn()} onSigned={onSigned} />)
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: '  Dr. R. Kunam ' } })
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
    fireEvent.click(signButton())

    await waitFor(() => expect(onSigned).toHaveBeenCalled())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/patients/P1/notes/5/sign')
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PUT')
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ typedName: 'Dr. R. Kunam', attested: true, password: 'secret-pass' })
  })

  it('asks a TOTP-only account for a six-digit code instead of a password', async () => {
    const fetchMock = mockFetch()
    render(<SignNoteDialog patientId="P1" noteId={5} reauthMethod="totp" onClose={vi.fn()} onSigned={vi.fn()} />)
    expect(screen.queryByLabelText('Password')).toBeNull()
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Dr. R. Kunam' } })
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '12345' } })
    expect(signButton()).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Authenticator code'), { target: { value: '123456' } })
    fireEvent.click(signButton())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ typedName: 'Dr. R. Kunam', attested: true, totpCode: '123456' })
  })

  it('shows the refusal and clears the password after a failed re-authentication', async () => {
    mockFetch(401, { error: 'Password or code is incorrect.', code: 'reauth_failed' })
    const onSigned = vi.fn()
    render(<SignNoteDialog patientId="P1" noteId={5} reauthMethod="password" onClose={vi.fn()} onSigned={onSigned} />)
    fireEvent.change(screen.getByLabelText('Your full name'), { target: { value: 'Dr. R. Kunam' } })
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(signButton())

    expect((await screen.findByRole('alert')).textContent).toBe('Password or code is incorrect.')
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('')
    expect(onSigned).not.toHaveBeenCalled()
  })

  it('explains when the account has no way to re-authenticate', () => {
    render(<SignNoteDialog patientId="P1" noteId={5} reauthMethod={null} onClose={vi.fn()} onSigned={vi.fn()} />)
    expect(screen.getByText(/cannot confirm your identity/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign note' })).toBeNull()
  })
})
