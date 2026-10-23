import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ProviderSchedulePanel } from '@/components/settings/ProviderSchedulePanel'
import { ToastProvider } from '@/components/ui/toast'

afterEach(() => { vi.unstubAllGlobals() })

const SCHEDULE = {
  slotMinutes: 15,
  opdRoom: 'OPD 3',
  sessions: [{ weekday: 1, start: '09:00', end: '13:00' }],
  leave: [{ date: '2099-01-15', reason: 'Conference' }],
}

type FetchMock = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>

function mockFetch(putResponse: Response = new Response(JSON.stringify({ ok: true }), { status: 200 })): FetchMock {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) =>
    init?.method === 'PUT' ? putResponse : new Response(JSON.stringify(SCHEDULE), { status: 200 }))
  vi.stubGlobal('fetch', fn)
  return fn
}

function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true)
  return open ? <ProviderSchedulePanel provider={{ id: 7, name: 'Dr Asha Rao' }} onClose={() => { onClose(); setOpen(false) }} /> : null
}

function setup(onClose = vi.fn()) {
  render(<ToastProvider><Harness onClose={onClose} /></ToastProvider>)
  return onClose
}

describe('ProviderSchedulePanel', () => {
  it('loads the schedule and shows Monday to Saturday, the slot length and leave', async () => {
    mockFetch()
    setup()
    expect(await screen.findByLabelText('Start, Monday session 1')).toHaveValue('09:00')
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
      expect(screen.getByRole('group', { name: day })).toBeInTheDocument()
    }
    expect(screen.queryByRole('group', { name: 'Sunday' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Slot length (minutes)')).toHaveValue('15')
    expect(screen.getByLabelText('Leave date, row 1')).toHaveValue('2099-01-15')
    expect(screen.getByLabelText('Leave reason, row 1')).toHaveValue('Conference')
  })

  it('edits Mon–Sat sessions, slot length and leave, saves with PUT and shows a toast', async () => {
    const fetchMock = mockFetch()
    const onClose = setup()
    await screen.findByLabelText('Start, Monday session 1')

    fireEvent.change(screen.getByLabelText('End, Monday session 1'), { target: { value: '12:00' } })
    const tuesday = screen.getByRole('group', { name: 'Tuesday' })
    fireEvent.click(within(tuesday).getByRole('button', { name: 'Add session, Tuesday' }))
    fireEvent.change(screen.getByLabelText('Start, Tuesday session 1'), { target: { value: '14:00' } })
    fireEvent.change(screen.getByLabelText('End, Tuesday session 1'), { target: { value: '17:00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add session, Saturday' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove Saturday session 1' }))
    fireEvent.change(screen.getByLabelText('Slot length (minutes)'), { target: { value: '20' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove leave row 1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add leave day' }))
    fireEvent.change(screen.getByLabelText('Leave date, row 1'), { target: { value: '2099-02-01' } })
    fireEvent.change(screen.getByLabelText('Leave reason, row 1'), { target: { value: 'Personal' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save working hours' }))
    expect(await screen.findByText('Working hours saved for Dr Asha Rao')).toBeInTheDocument()
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!
    expect(put[0]).toBe('/api/providers/7/schedule')
    expect(JSON.parse(put[1]!.body as string)).toEqual({
      slotMinutes: 20,
      sessions: [
        { weekday: 1, start: '09:00', end: '12:00' },
        { weekday: 2, start: '14:00', end: '17:00' },
      ],
      leave: [{ date: '2099-02-01', reason: 'Personal' }],
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('blocks saving an end that is not after its start', async () => {
    const fetchMock = mockFetch()
    setup()
    await screen.findByLabelText('Start, Monday session 1')
    fireEvent.change(screen.getByLabelText('End, Monday session 1'), { target: { value: '08:00' } })
    expect(screen.getByText('Monday: each session must end after it starts.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save working hours' })).toBeDisabled()
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)
  })

  it('shows the server refusal and stays open', async () => {
    mockFetch(new Response(JSON.stringify({ error: 'Sessions on the same day must not overlap' }), { status: 400 }))
    const onClose = setup()
    await screen.findByLabelText('Start, Monday session 1')
    fireEvent.click(screen.getByRole('button', { name: 'Save working hours' }))
    expect(await screen.findByText('Sessions on the same day must not overlap')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
