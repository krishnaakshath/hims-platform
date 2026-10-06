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
    expect(input).toHaveAccessibleDescription('Use the email address the clinic has on file, or the patient ID from your paperwork.')
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
