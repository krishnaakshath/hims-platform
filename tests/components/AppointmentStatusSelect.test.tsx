import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AppointmentStatusSelect } from '@/components/AppointmentStatusSelect'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AppointmentStatusSelect', () => {
  it('shows an error and re-enables the select when the server rejects the update', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Cannot move to that status' }), { status: 400 })))
    render(<AppointmentStatusSelect appointmentId={1} status="scheduled" />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed' } })

    await waitFor(() => expect(screen.getByText('Cannot move to that status')).toBeInTheDocument())
    expect(screen.getByRole('combobox')).not.toBeDisabled()
  })

  it('shows a generic error and re-enables the select on a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    render(<AppointmentStatusSelect appointmentId={1} status="scheduled" />)

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'completed' } })

    await waitFor(() => expect(screen.getByText('Could not reach the server.')).toBeInTheDocument())
    expect(screen.getByRole('combobox')).not.toBeDisabled()
  })
})
