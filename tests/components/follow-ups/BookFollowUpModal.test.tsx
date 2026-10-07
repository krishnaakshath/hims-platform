import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { BookFollowUpModal } from '@/components/follow-ups/BookFollowUpModal'
import { FU } from './fixtures'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

const PROVIDERS = [{ id: 7, name: 'Dr. K' }, { id: 8, name: 'Dr. L' }]

describe('BookFollowUpModal', () => {
  it('defaults to the later of due date and today and sends +05:30 times', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ order: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const onClose = vi.fn()
    render(<BookFollowUpModal followUp={FU} providers={PROVIDERS} todayIso="2026-10-20" onClose={onClose} />)
    expect(screen.getByLabelText(/^date/i)).toHaveValue('2026-10-21')
    expect(screen.getByLabelText(/doctor/i)).toHaveValue('7')
    fireEvent.click(screen.getByRole('button', { name: /^book appointment/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/follow-ups/5/booking')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ providerId: 7, startsAt: '2026-10-21T09:00:00+05:30', endsAt: '2026-10-21T09:15:00+05:30' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(refresh).toHaveBeenCalled()
  })

  it('uses today when the due date has passed', () => {
    render(<BookFollowUpModal followUp={FU} providers={PROVIDERS} todayIso="2026-11-02" onClose={vi.fn()} />)
    expect(screen.getByLabelText(/^date/i)).toHaveValue('2026-11-02')
  })

  it('warns when the chosen date is outside the window, without blocking', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ order: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BookFollowUpModal followUp={FU} providers={PROVIDERS} todayIso="2026-10-20" onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/^date/i), { target: { value: '2026-11-15' } })
    expect(screen.getByRole('alert')).toHaveTextContent(/outside the follow-up window/i)
    fireEvent.click(screen.getByRole('button', { name: /^book appointment/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  })

  it('shows the server conflict message in an alert and stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'That slot is already taken.' }), { status: 409 })))
    const onClose = vi.fn()
    render(<BookFollowUpModal followUp={FU} providers={PROVIDERS} todayIso="2026-10-20" onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /^book appointment/i }))
    expect(await screen.findByText(/already taken/)).toBeInTheDocument()
    expect(screen.getAllByRole('alert').some((a) => /already taken/.test(a.textContent ?? ''))).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers 10/15/20/30 minute durations and applies the choice', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BookFollowUpModal followUp={FU} providers={PROVIDERS} todayIso="2026-10-20" onClose={vi.fn()} />)
    const dur = screen.getByLabelText(/duration/i) as HTMLSelectElement
    expect([...dur.options].map((o) => o.value)).toEqual(['10', '15', '20', '30'])
    fireEvent.change(dur, { target: { value: '30' } })
    fireEvent.change(screen.getByLabelText(/^time/i), { target: { value: '10:30' } })
    fireEvent.click(screen.getByRole('button', { name: /^book appointment/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.startsAt).toBe('2026-10-21T10:30:00+05:30')
    expect(body.endsAt).toBe('2026-10-21T11:00:00+05:30')
  })

  it('does not preselect a prescriber who is not an active doctor, and requires a choice', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<BookFollowUpModal followUp={{ ...FU, prescribedBy: { providerId: 99, name: 'Dr. Gone' } }} providers={PROVIDERS} todayIso="2026-10-20" onClose={vi.fn()} />)
    expect(screen.getByLabelText(/doctor/i)).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: /^book appointment/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/choose a doctor/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
