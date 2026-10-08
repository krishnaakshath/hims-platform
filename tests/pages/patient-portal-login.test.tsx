import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PatientPortalLoginPage from '@/app/patient-portal/login/page'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

afterEach(() => {
  vi.unstubAllGlobals()
  push.mockClear()
})

describe('Patient portal login page', () => {
  it('labels the identifier field "Email address or patient ID"', () => {
    render(<PatientPortalLoginPage />)
    const input = screen.getByLabelText('Email address or patient ID')
    expect(input).toHaveAttribute('placeholder', 'name@example.com or RD-0001')
    expect(input).toHaveAttribute('autocomplete', 'username')
    expect(input).toHaveAccessibleDescription('Use the email address the clinic has on file, or the UHID or patient ID from your paperwork.')
    expect(screen.queryByText('Email Address')).not.toBeInTheDocument()
  })

  it('posts a typed email as the login identifier and goes to the portal on success', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PatientPortalLoginPage />)

    fireEvent.change(screen.getByLabelText('Email address or patient ID'), { target: { value: 'maria@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/patient-portal'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patient-portal/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ patientId: 'maria@example.com', password: 'secret-pass' })
  })

  it('shows the server\'s generic error on a failed sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid patient ID or password' }), { status: 401 })))
    render(<PatientPortalLoginPage />)
    fireEvent.change(screen.getByLabelText('Email address or patient ID'), { target: { value: 'nobody@example.com' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Invalid patient ID or password')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })
})

// Wave J (P1-20): UHID / mobile OTP sign-in.
describe('Patient portal login page: mobile code', () => {
  it('sends a code for a UHID or mobile, then signs in with the code', async () => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith('/otp')
      ? new Response(JSON.stringify({ sent: true, message: 'If these details match a portal account, a 6-digit code has been sent.' }), { status: 200 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PatientPortalLoginPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a code sent to your mobile' }))
    fireEvent.change(screen.getByLabelText('UHID or mobile number'), { target: { value: '98450 00001' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(await screen.findByRole('status')).toHaveTextContent('a 6-digit code has been sent')
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '12a3456' } })
    expect(screen.getByLabelText('6-digit code')).toHaveValue('123456')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/patient-portal'))
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    expect(calls.map(([u]) => u)).toEqual(['/api/patient-portal/login/otp', '/api/patient-portal/login/otp/verify'])
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ identifier: '98450 00001', code: '123456' })
  })

  it('shows the generic error for a wrong code and can go back to the password form', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/otp')
      ? new Response(JSON.stringify({ sent: true }), { status: 200 })
      : new Response(JSON.stringify({ error: 'Invalid or expired code' }), { status: 401 })))
    render(<PatientPortalLoginPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a code sent to your mobile' }))
    fireEvent.change(screen.getByLabelText('UHID or mobile number'), { target: { value: 'HIMS000000011' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    fireEvent.change(await screen.findByLabelText('6-digit code'), { target: { value: '000000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Invalid or expired code')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use my password instead' }))
    expect(screen.getByLabelText('Email address or patient ID')).toBeInTheDocument()
  })
})
