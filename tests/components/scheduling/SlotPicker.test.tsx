import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { SlotPicker } from '@/components/scheduling/SlotPicker'

// WS6 T7 (spec D5): the booking slot picker over GET /api/providers/[id]/slots.

const slot = (hhmm: string, status: 'free' | 'booked' | 'past') => {
  const startsAt = new Date(`2026-11-02T${hhmm}:00+05:30`)
  return { startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 15 * 60_000).toISOString(), status }
}

function stubSlots(body: unknown, status = 200) {
  const m = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', m)
  return m
}

const DAY = { date: '2026-11-02', slotMinutes: 15, onLeave: false, hoursSet: true, slots: [slot('09:00', 'past'), slot('09:15', 'booked'), slot('09:30', 'free'), slot('09:45', 'free')] }

afterEach(() => { vi.unstubAllGlobals() })

describe('SlotPicker', () => {
  it("fetches the doctor's slots for the date and fills start and end from a free slot", async () => {
    const fetchMock = stubSlots(DAY)
    const onChange = vi.fn()
    render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={onChange} allowCustom />)
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/4/slots?date=2026-11-02', expect.anything())
    fireEvent.click(await screen.findByRole('button', { name: /09:30/ }))
    expect(onChange).toHaveBeenLastCalledWith({ startsAt: DAY.slots[2].startsAt, endsAt: DAY.slots[2].endsAt, outsideHours: false })
  })

  it('disables booked and past slots', async () => {
    stubSlots(DAY)
    render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={vi.fn()} allowCustom />)
    expect(await screen.findByRole('button', { name: /09:00.*past/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /09:15.*booked/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /09:45/ })).toBeEnabled()
  })

  it('marks the chosen slot as pressed', async () => {
    stubSlots(DAY)
    render(<SlotPicker providerId={4} date="2026-11-02" value={{ startsAt: DAY.slots[3].startsAt, endsAt: DAY.slots[3].endsAt }} onChange={vi.fn()} allowCustom />)
    expect(await screen.findByRole('button', { name: /09:45/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /09:30/ })).toHaveAttribute('aria-pressed', 'false')
  })

  it('"Other time" inside working hours needs no confirmation', async () => {
    stubSlots(DAY)
    const onChange = vi.fn()
    render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={onChange} allowCustom />)
    fireEvent.click(await screen.findByRole('button', { name: 'Other time' }))
    fireEvent.change(screen.getByLabelText('Start time (IST)'), { target: { value: '09:35' } })
    fireEvent.change(screen.getByLabelText('End time (IST)'), { target: { value: '09:50' } })
    expect(screen.queryByLabelText(/outside working hours/i)).toBeNull()
    expect(onChange).toHaveBeenLastCalledWith({ startsAt: '2026-11-02T09:35:00+05:30', endsAt: '2026-11-02T09:50:00+05:30', outsideHours: false })
  })

  it('"Other time" outside working hours is held back until the confirmation is ticked', async () => {
    stubSlots(DAY)
    const onChange = vi.fn()
    render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={onChange} allowCustom />)
    fireEvent.click(await screen.findByRole('button', { name: 'Other time' }))
    fireEvent.change(screen.getByLabelText('Start time (IST)'), { target: { value: '18:00' } })
    fireEvent.change(screen.getByLabelText('End time (IST)'), { target: { value: '18:15' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    fireEvent.click(screen.getByLabelText(/outside working hours/i))
    expect(onChange).toHaveBeenLastCalledWith({ startsAt: '2026-11-02T18:00:00+05:30', endsAt: '2026-11-02T18:15:00+05:30', outsideHours: true })
  })

  it('hides "Other time" when custom times are not allowed', async () => {
    stubSlots(DAY)
    render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={vi.fn()} allowCustom={false} />)
    await screen.findByRole('button', { name: /09:30/ })
    expect(screen.queryByRole('button', { name: 'Other time' })).toBeNull()
  })

  it('a doctor with no working hours set gets a note and the time inputs directly', async () => {
    stubSlots({ date: '2026-11-02', slotMinutes: 15, onLeave: false, hoursSet: false, slots: [] })
    const onChange = vi.fn()
    render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={onChange} allowCustom />)
    expect(await screen.findByText(/no working hours/i)).toBeInTheDocument()
    expect(screen.getByLabelText('Start time (IST)')).toHaveValue('09:00')
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ startsAt: '2026-11-02T09:00:00+05:30', endsAt: '2026-11-02T09:30:00+05:30', outsideHours: false }))
    expect(screen.queryByLabelText(/outside working hours/i)).toBeNull()
  })

  it('a leave day says so and any time needs the outside-hours confirmation', async () => {
    stubSlots({ date: '2026-11-02', slotMinutes: 15, onLeave: true, hoursSet: true, slots: [] })
    const onChange = vi.fn()
    render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={onChange} allowCustom />)
    expect(await screen.findByText(/on leave/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/outside working hours/i)).not.toBeChecked()
    expect(onChange).toHaveBeenLastCalledWith(null)
    fireEvent.click(screen.getByLabelText(/outside working hours/i))
    expect(onChange).toHaveBeenLastCalledWith({ startsAt: '2026-11-02T09:00:00+05:30', endsAt: '2026-11-02T09:30:00+05:30', outsideHours: true })
  })

  it('a weekday the doctor does not work needs the outside-hours confirmation (hours are set up)', async () => {
    stubSlots({ date: '2026-11-03', slotMinutes: 15, onLeave: false, hoursSet: true, slots: [] })
    const onChange = vi.fn()
    render(<SlotPicker providerId={4} date="2026-11-03" value={null} onChange={onChange} allowCustom />)
    expect(await screen.findByText(/no working hours on this day/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/outside working hours/i)).not.toBeChecked()
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('loads again and clears the value when the date changes', async () => {
    const fetchMock = stubSlots(DAY)
    const onChange = vi.fn()
    const { rerender } = render(<SlotPicker providerId={4} date="2026-11-02" value={null} onChange={onChange} allowCustom />)
    fireEvent.click(await screen.findByRole('button', { name: /09:30/ }))
    rerender(<SlotPicker providerId={4} date="2026-11-09" value={null} onChange={onChange} allowCustom />)
    expect(onChange).toHaveBeenLastCalledWith(null)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/providers/4/slots?date=2026-11-09', expect.anything()))
  })
})
