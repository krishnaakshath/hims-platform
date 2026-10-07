import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { FollowUpPanel } from '@/components/follow-ups/FollowUpPanel'
import { FU, BOOKED, ENC, PROPS } from './fixtures'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

const NONE = { plan: false, book: false, checkIn: false, startOrComplete: false, cancelVisit: false }

describe('FollowUpPanel', () => {
  it('frontdesk sees reason and booking actions but no plan actions or notes', () => {
    render(<FollowUpPanel {...PROPS} followUps={[{ ...FU, planNotes: null }]} can={{ plan: false, book: true, checkIn: true, startOrComplete: false, cancelVisit: true }} isPi={false} />)
    expect(screen.getByText('BP review')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /set follow-up|change plan/i })).toBeNull()
    expect(screen.queryByText(/renal panel/)).toBeNull()
    expect(screen.getByRole('button', { name: /book/i })).toBeInTheDocument()
  })

  it('pi sees plan actions and notes, no booking actions', () => {
    render(<FollowUpPanel {...PROPS} selfProviderId={7} can={{ ...NONE, plan: true }} isPi />)
    expect(screen.getByRole('button', { name: /set follow-up/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /change plan/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel follow-up/i })).toBeInTheDocument()
    expect(screen.getByText(/renal panel/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^book$|log contact/i })).toBeNull()
  })

  it('crc is read-only', () => {
    render(<FollowUpPanel {...PROPS} can={NONE} />)
    expect(screen.getByText('BP review')).toBeInTheDocument()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('shows Check in only for a booking on today\'s IST date', () => {
    const can = { ...NONE, book: true, checkIn: true }
    render(<FollowUpPanel {...PROPS} todayIso="2026-10-22" followUps={[BOOKED]} can={can} />)
    expect(screen.getByRole('button', { name: /check in/i })).toBeInTheDocument()
    cleanup()
    const earlier = { ...BOOKED, appointment: { ...BOOKED.appointment!, startsAt: new Date('2026-10-21T10:00:00Z') } }
    render(<FollowUpPanel {...PROPS} todayIso="2026-10-22" followUps={[earlier]} can={can} />)
    expect(screen.queryByRole('button', { name: /check in/i })).toBeNull()
  })

  it('formats the booking in IST without locale APIs', () => {
    render(<FollowUpPanel {...PROPS} todayIso="2026-10-20" followUps={[BOOKED]} can={NONE} />)
    expect(screen.getByText(/22 Oct 2026, 12:30 am/)).toBeInTheDocument()
    expect(screen.getByText(/21 Oct 2026/)).toBeInTheDocument()
  })

  it('lists open follow-ups before closed ones', () => {
    const closed = { ...FU, id: 6, status: 'completed' as const, bucket: 'closed' as const, reason: 'Old one' }
    render(<FollowUpPanel {...PROPS} followUps={[closed, FU]} can={NONE} />)
    const items = screen.getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(items.findIndex((t) => t.includes('BP review'))).toBeLessThan(items.findIndex((t) => t.includes('Old one')))
  })

  it('cancelling a follow-up asks for a reason first and surfaces a server error in an alert', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'This follow-up is already completed or cancelled.' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<FollowUpPanel {...PROPS} selfProviderId={7} can={{ ...NONE, plan: true }} isPi />)
    fireEvent.click(screen.getByRole('button', { name: /cancel follow-up/i }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: 'Patient moved' } })
    fireEvent.click(screen.getByRole('button', { name: /^confirm/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already completed or cancelled/)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/follow-ups/5/cancel')
    expect(JSON.parse(init.body as string)).toEqual({ reason: 'Patient moved' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('unbooking confirms first and refreshes on success', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ order: null }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<FollowUpPanel {...PROPS} todayIso="2026-10-20" followUps={[BOOKED]} can={{ ...NONE, book: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /cancel booking/i }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: 'Asked to move' } })
    fireEvent.click(screen.getByRole('button', { name: /^confirm/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('/api/follow-ups/5/unbook')
  })

  it('check-in posts an outpatient routine check-in against the appointment', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<FollowUpPanel {...PROPS} todayIso="2026-10-22" followUps={[BOOKED]} can={{ ...NONE, checkIn: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /check in/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/front-desk/check-in')
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ patientId: 'RD-0001', providerId: 7, appointmentId: 31, visitType: 'outpatient', urgency: 'routine' })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('renders visits with status actions per role and an empty state', () => {
    render(<FollowUpPanel {...PROPS} followUps={[]} encounters={[]} can={NONE} />)
    expect(screen.getByText(/no follow-ups/i)).toBeInTheDocument()
    expect(screen.getByText(/no visits/i)).toBeInTheDocument()
    cleanup()
    render(<FollowUpPanel {...PROPS} followUps={[]} encounters={[ENC]} can={{ ...NONE, startOrComplete: true, cancelVisit: true }} />)
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /start consultation/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /complete visit/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel visit/i })).toBeInTheDocument()
  })

  it('a pi who did not prescribe the follow-up sees a read-only note, not plan actions', () => {
    render(<FollowUpPanel {...PROPS} selfProviderId={8} can={{ ...NONE, plan: true }} isPi />)
    expect(screen.queryByRole('button', { name: /change plan|cancel follow-up/i })).toBeNull()
    expect(screen.getByText(/Prescribed by Dr\. K/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /set follow-up/i })).toBeInTheDocument()
  })

  it('a pi with no linked provider cannot set or change follow-ups', () => {
    render(<FollowUpPanel {...PROPS} selfProviderId={null} can={{ ...NONE, plan: true }} isPi />)
    expect(screen.queryByRole('button', { name: /set follow-up|change plan|cancel follow-up/i })).toBeNull()
  })

  it('admin may change any prescriber\'s plan', () => {
    render(<FollowUpPanel {...PROPS} selfProviderId={null} can={{ ...NONE, plan: true }} isPi={false} />)
    expect(screen.getByRole('button', { name: /change plan/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel follow-up/i })).toBeInTheDocument()
  })

  it('a pi only starts or completes their own visits', () => {
    const can = { ...NONE, startOrComplete: true }
    render(<FollowUpPanel {...PROPS} followUps={[]} encounters={[ENC]} selfProviderId={7} isPi can={can} />)
    expect(screen.getByRole('button', { name: /start consultation/i })).toBeInTheDocument()
    cleanup()
    render(<FollowUpPanel {...PROPS} followUps={[]} encounters={[ENC]} selfProviderId={8} isPi can={can} />)
    expect(screen.queryByRole('button', { name: /start consultation|complete visit/i })).toBeNull()
    cleanup()
    render(<FollowUpPanel {...PROPS} followUps={[]} encounters={[ENC]} selfProviderId={null} isPi={false} can={can} />)
    expect(screen.getByRole('button', { name: /complete visit/i })).toBeInTheDocument()
  })
})
