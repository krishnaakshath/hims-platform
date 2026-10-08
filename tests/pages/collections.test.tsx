// SP5 Task 12: the collector's "My route" page (/collections) and its CollectorRoute screen, with
// the session, the audit log, the route query and fetch mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react'

let role = 'collector'
let userId: number | null = 7
const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
  useRouter: () => ({ refresh, push: vi.fn() }),
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'TEST_SP5 route', userId })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/home-collections', () => ({ listCollectorRoute: vi.fn() }))

import Page from '@/app/(dashboard)/collections/page'
import { listCollectorRoute, type RouteStop } from '@/lib/queries/home-collections'
import { logAudit } from '@/lib/audit'
import { redirect } from 'next/navigation'
import { todayIsoIn } from '@/lib/india-time'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { displaySampleId, formatSampleId } from '@/lib/labs/sample-id'

const SID_A = formatSampleId('2099-06-02', 42)
const SID_B = formatSampleId('2099-06-02', 43)
const STOP: RouteStop = {
  visitId: 77, status: 'booked', windowLabel: 'Morning 7-9', windowStart: '07:00', windowEnd: '09:00',
  patient: { id: 'RD-0001', name: 'Asha R.', uhid: 'UH-000042', ageYears: 44, gender: 'female' },
  contactPhone: '+919845013210',
  address: { line1: '12 MG Road', line2: 'Flat 3', city: 'Pune', district: null, stateCode: 'IN-MH', pinCode: '411001', landmark: 'Opp. the temple' },
  notes: 'Ring twice',
  tests: [
    { orderId: 11, testName: 'Glucose, fasting', sampleType: 'plasma', container: 'fluoride_grey', sampleId: SID_A, status: 'scheduled' },
    { orderId: 12, testName: 'CBC', sampleType: 'blood', container: 'edta_lavender', sampleId: SID_B, status: 'scheduled' },
  ],
}
const props = (date?: string) => ({ searchParams: Promise.resolve(date === undefined ? {} : { date }) })
const fetchMock = vi.fn()

beforeEach(() => {
  role = 'collector'
  userId = 7
  vi.mocked(listCollectorRoute).mockReset().mockResolvedValue([STOP])
  vi.mocked(logAudit).mockClear()
  vi.mocked(redirect).mockClear()
  refresh.mockClear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('/collections', () => {
  it.each(['pi', 'crc', 'billing', 'pharmacy', 'frontdesk', 'labs'])('%s is redirected before any query', async (r) => {
    role = r
    await expect(Page(props())).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
    expect(listCollectorRoute).not.toHaveBeenCalled()
  })

  it('collector sees only own stops; admin sees all', async () => {
    const today = todayIsoIn()
    await Page(props())
    expect(listCollectorRoute).toHaveBeenLastCalledWith(7, today)
    expect(logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ role: 'collector' }), 'viewed collection route', null, `date=${today} stops=1`)
    role = 'admin'
    userId = null
    await Page(props())
    expect(listCollectorRoute).toHaveBeenLastCalledWith(null, today)
  })

  it('a collector without a user id gets an empty list, never the all-visits view', async () => {
    userId = null
    render(await Page(props()))
    expect(listCollectorRoute).not.toHaveBeenCalled()
    expect(screen.getByText(/no visits assigned/i)).toBeInTheDocument()
  })

  it('admin may pick any date; a collector only today or an upcoming day', async () => {
    const today = todayIsoIn()
    role = 'admin'
    await Page(props('2001-01-02'))
    expect(listCollectorRoute).toHaveBeenLastCalledWith(null, '2001-01-02')
    await Page(props('2099-02-30'))
    expect(listCollectorRoute).toHaveBeenLastCalledWith(null, today)
    role = 'collector'
    const tomorrow = addDaysIso(today, 1)
    await Page(props(tomorrow))
    expect(listCollectorRoute).toHaveBeenLastCalledWith(7, tomorrow)
    await Page(props(addDaysIso(today, -1)))
    expect(listCollectorRoute).toHaveBeenLastCalledWith(7, today)
  })

  it('shows each stop: window, patient, phone link, address, landmark, tubes and sample IDs', async () => {
    render(await Page(props()))
    const stop = screen.getByRole('article', { name: /Asha R\./ })
    expect(within(stop).getByText(/Morning 7-9/)).toBeInTheDocument()
    expect(within(stop).getByText(/UH-000042/)).toBeInTheDocument()
    expect(within(stop).getByText(/44 y · Female/)).toBeInTheDocument()
    expect(within(stop).getByRole('link', { name: /call/i })).toHaveAttribute('href', 'tel:+919845013210')
    expect(within(stop).getByText(/12 MG Road, Flat 3/)).toBeInTheDocument()
    expect(within(stop).getByText(/Opp\. the temple/)).toBeInTheDocument()
    expect(within(stop).getByText(displaySampleId(SID_A))).toBeInTheDocument()
    expect(within(stop).getByText(/Fluoride \(grey cap\)/)).toBeInTheDocument()
    expect(within(stop).getByText(/Ring twice/)).toBeInTheDocument()
  })

  it('Mark collected posts the entered tubes; an empty tube is left out', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, collectedOrderIds: [11], notCollectedOrderIds: [12], encounterId: 5 }), { status: 200 }))
    render(await Page(props()))
    fireEvent.click(screen.getByRole('button', { name: /mark collected/i }))
    const inputs = screen.getAllByRole('textbox', { name: /scan or type the tube's sample id/i })
    expect(inputs).toHaveLength(2)
    fireEvent.change(inputs[0], { target: { value: displaySampleId(SID_A) } })
    fireEvent.click(screen.getByRole('button', { name: /save collection/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/home-collections/77/collect')
    expect(JSON.parse(init.body)).toEqual({ sampleIds: [displaySampleId(SID_A)] })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('a typed ID with a bad check digit is caught before posting; a server error stays visible', async () => {
    render(await Page(props()))
    fireEvent.click(screen.getByRole('button', { name: /mark collected/i }))
    const inputs = screen.getAllByRole('textbox', { name: /scan or type the tube's sample id/i })
    const typo = `${SID_A.slice(0, -1)}${(Number(SID_A.at(-1)) + 1) % 10}`
    fireEvent.change(inputs[0], { target: { value: typo } })
    fireEvent.click(screen.getByRole('button', { name: /save collection/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not valid/i)
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'Sample L990602-0043-1 does not belong to this visit. Check the tube label.' }), { status: 409 }))
    fireEvent.change(inputs[0], { target: { value: SID_A } })
    fireEvent.click(screen.getByRole('button', { name: /save collection/i }))
    expect(await screen.findByText(/does not belong to this visit/)).toBeInTheDocument()
  })

  it('Could not collect offers only the doorstep reasons', async () => {
    render(await Page(props()))
    fireEvent.click(screen.getByRole('button', { name: /could not collect/i }))
    const select = await screen.findByRole('combobox', { name: /reason/i })
    const options = within(select).getAllByRole('option').map((o) => o.getAttribute('value')).filter(Boolean)
    expect(options).toEqual(['patient_unavailable', 'patient_refused', 'address_not_found'])
  })

  it('a collected stop shows no actions', async () => {
    vi.mocked(listCollectorRoute).mockResolvedValue([{ ...STOP, status: 'collected', tests: STOP.tests.map((t) => ({ ...t, status: 'collected' })) }])
    render(await Page(props()))
    expect(screen.queryByRole('button', { name: /mark collected/i })).toBeNull()
    expect(screen.getAllByText(/collected/i).length).toBeGreaterThan(0)
  })
})
