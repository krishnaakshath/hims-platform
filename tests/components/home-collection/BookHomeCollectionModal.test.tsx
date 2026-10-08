// SP5 Task 11: the booking modal (patient lookup, window availability, address snapshot).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { BookHomeCollectionModal } from '@/components/home-collection/BookHomeCollectionModal'
import { bookHomeCollectionSchema } from '@/lib/labs/validation'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

const CONTEXT = (isLocal: boolean) => ({
  patient: {
    id: 'RD-0001', name: 'Asha Rao', uhid: 'UH-000042', phone: '+919845013210', addressLine1: '12 MG Road', addressLine2: null,
    city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: isLocal ? '411001' : '560001', notificationOptOut: false,
  },
  isLocal,
  bookableOrders: [
    { id: 11, testName: 'Glucose, fasting', sampleType: 'plasma', container: 'fluoride_grey' },
    { id: 12, testName: 'Lipid panel', sampleType: 'serum', container: 'sst_gold' },
  ],
  bookableOrderCount: 2,
  activeVisits: [],
})
const WINDOWS = [
  { windowId: 3, label: 'Morning 7-9', startTime: '07:00', endTime: '09:00', capacity: 4, booked: 1, remaining: 3, closed: false },
  { windowId: 4, label: 'Midday 11-1', startTime: '11:00', endTime: '13:00', capacity: 2, booked: 2, remaining: 0, closed: false },
  { windowId: 5, label: 'Early 6-7', startTime: '06:00', endTime: '07:00', capacity: 2, booked: 0, remaining: 2, closed: true },
]

function mockFetch(isLocal: boolean, bookResponse?: Response) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/home-collections/context')) return new Response(JSON.stringify(CONTEXT(isLocal)), { status: 200 })
    if (url.startsWith('/api/home-collections/availability')) return new Response(JSON.stringify(WINDOWS), { status: 200 })
    if (url === '/api/home-collections' && init?.method === 'POST') {
      return bookResponse ?? new Response(JSON.stringify({ visit: { id: 77 }, sampleIds: { 11: 'L26100800429' } }), { status: 201 })
    }
    return new Response('{}', { status: 404 })
  })
}

async function findPatient() {
  fireEvent.change(screen.getByLabelText(/patient id or uhid/i), { target: { value: 'UH-000042' } })
  fireEvent.click(screen.getByRole('button', { name: /find patient/i }))
  await screen.findByText(/Asha Rao/)
}

describe('BookHomeCollectionModal', () => {
  it('disables full and closed windows and shows the walk-in-only note for a non-local patient', async () => {
    vi.stubGlobal('fetch', mockFetch(false))
    render(<BookHomeCollectionModal date="2099-07-02" onClose={vi.fn()} />)
    await findPatient()
    expect(screen.getByText('Outside the service area: walk-in only')).toBeInTheDocument()
    const select = await screen.findByLabelText(/collection window/i)
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1))
    expect(within(select).getByRole('option', { name: /Morning 7-9.*3 left/ })).not.toBeDisabled()
    expect(within(select).getByRole('option', { name: /Midday 11-1.*full/i })).toBeDisabled()
    expect(within(select).getByRole('option', { name: /Early 6-7.*closed/i })).toBeDisabled()
    // The address stays editable: the visit PIN decides.
    expect(screen.getByLabelText(/^PIN code/i)).not.toBeDisabled()
  })

  it('posts the edited address snapshot and selected orders, then shows the sample IDs', async () => {
    const fetchMock = mockFetch(true)
    vi.stubGlobal('fetch', fetchMock)
    render(<BookHomeCollectionModal date="2099-07-02" onClose={vi.fn()} />)
    await findPatient()
    expect(screen.queryByText('Outside the service area: walk-in only')).toBeNull()
    expect(screen.getByRole('checkbox', { name: /Glucose, fasting/ })).toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: /Lipid panel/ }))
    const select = await screen.findByLabelText(/collection window/i)
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: '3' } })
    expect(screen.getByLabelText(/^address line 1/i)).toHaveValue('12 MG Road')
    fireEvent.change(screen.getByLabelText(/^address line 1/i), { target: { value: 'Flat 4, 9 FC Road' } })
    fireEvent.change(screen.getByLabelText(/^landmark/i), { target: { value: 'Near the temple' } })
    fireEvent.click(screen.getByRole('button', { name: /book collection/i }))

    await screen.findByText('L261008-0042-9')
    const post = fetchMock.mock.calls.find(([u, i]) => u === '/api/home-collections' && i?.method === 'POST')!
    const body = JSON.parse(post[1]!.body as string)
    expect(bookHomeCollectionSchema.safeParse(body).success).toBe(true)
    expect(body).toMatchObject({
      patientId: 'RD-0001',
      labOrderIds: [11],
      visitDate: '2099-07-02',
      windowId: 3,
      address: { line1: 'Flat 4, 9 FC Road', city: 'Pune', district: 'Pune', stateCode: 'IN-MH', pinCode: '411001', landmark: 'Near the temple' },
      contactPhone: '+919845013210',
    })
    expect(screen.getByRole('link', { name: /print labels/i })).toHaveAttribute('href', '/lab-labels?orders=11')
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the server error and stays open', async () => {
    vi.stubGlobal('fetch', mockFetch(true, new Response(JSON.stringify({ error: 'That collection window is full. Pick another window.' }), { status: 409 })))
    const onClose = vi.fn()
    render(<BookHomeCollectionModal date="2099-07-02" onClose={onClose} />)
    await findPatient()
    const select = await screen.findByLabelText(/collection window/i)
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: /book collection/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That collection window is full. Pick another window.')
    expect(onClose).not.toHaveBeenCalled()
  })
})
