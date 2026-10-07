// SP5 Task 11: the /home-collections day board, with the session, the audit log and the
// booking queries mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

let role = 'frontdesk'
vi.mock('next/navigation', () => ({
  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'TEST_SP5 board', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/home-collections', () => ({ listHomeCollectionBoard: vi.fn(), listCollectors: vi.fn() }))

import Page from '@/app/(dashboard)/home-collections/page'
import { listCollectors, listHomeCollectionBoard, type BoardVisit } from '@/lib/queries/home-collections'
import { logAudit } from '@/lib/audit'
import { redirect } from 'next/navigation'
import { todayIsoIn } from '@/lib/india-time'

const VISIT: BoardVisit = {
  id: 77, status: 'booked', visitDate: '2099-07-02', windowId: 3, windowLabel: 'Morning 7-9', patientId: 'RD-0001', patientName: 'Asha Rao',
  uhid: 'UH-000042', city: 'Pune', pinCode: '411001', contactPhone: '+919845013210', collector: null, rescheduleCount: 0,
  tests: [{ orderId: 11, testName: 'Glucose, fasting', sampleId: 'L26100800429', container: 'fluoride_grey', status: 'scheduled' }],
}
const WINDOWS = [
  { windowId: 3, label: 'Morning 7-9', startTime: '07:00', endTime: '09:00', capacity: 4, booked: 1, remaining: 3, closed: false },
  { windowId: 4, label: 'Evening 5-7', startTime: '17:00', endTime: '19:00', capacity: 2, booked: 2, remaining: 0, closed: false },
]
const props = (date?: string) => ({ searchParams: Promise.resolve(date === undefined ? {} : { date }) })

beforeEach(() => {
  role = 'frontdesk'
  vi.mocked(listHomeCollectionBoard).mockReset().mockResolvedValue({ windows: WINDOWS, visits: [VISIT], totalVisits: 1 })
  vi.mocked(listCollectors).mockReset().mockResolvedValue([{ id: 9, name: 'Ravi Collector' }])
  vi.mocked(logAudit).mockClear()
  vi.mocked(redirect).mockClear()
})
afterEach(() => cleanup())

describe('/home-collections', () => {
  it.each(['pi', 'crc', 'billing', 'pharmacy', 'collector'])('%s is redirected before any query', async (r) => {
    role = r
    await expect(Page(props())).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
    expect(listHomeCollectionBoard).not.toHaveBeenCalled()
  })

  it('frontdesk sees the board without the collector select', async () => {
    render(await Page(props('2099-07-02')))
    expect(screen.getByRole('heading', { name: /home collection/i })).toBeInTheDocument()
    const row = screen.getByRole('row', { name: /Asha Rao/ })
    expect(within(row).getByText('UH-000042', { exact: false })).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: /\+919845013210/ })).toHaveAttribute('href', 'tel:+919845013210')
    expect(within(row).getByText('L261008-0042-9')).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: /print labels/i })).toHaveAttribute('href', '/lab-labels?orders=11')
    expect(within(row).queryByRole('combobox', { name: /collector/i })).toBeNull()
    expect(within(row).getByText('Unassigned')).toBeInTheDocument()
    expect(screen.getByText(/Morning 7-9 · 1\/4/)).toBeInTheDocument()
    expect(screen.getByText(/Evening 5-7 · 2\/2/)).toBeInTheDocument()
    expect(listCollectors).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }), 'viewed home collection board', null, 'date=2099-07-02 visits=1')
  })

  it('labs gets the collector select', async () => {
    role = 'labs'
    render(await Page(props('2099-07-02')))
    const select = screen.getByRole('combobox', { name: /collector for Asha Rao/i })
    expect(within(select).getByRole('option', { name: 'Ravi Collector' })).toBeInTheDocument()
  })

  it('uses the IST date by default and a valid ?date', async () => {
    await Page(props())
    expect(listHomeCollectionBoard).toHaveBeenCalledWith(todayIsoIn())
    await Page(props('2099-07-02'))
    expect(listHomeCollectionBoard).toHaveBeenLastCalledWith('2099-07-02')
    await Page(props('2099-02-30'))
    expect(listHomeCollectionBoard).toHaveBeenLastCalledWith(todayIsoIn())
  })

  it('prev/next day links and a raw-count cap notice', async () => {
    vi.mocked(listHomeCollectionBoard).mockResolvedValue({ windows: WINDOWS, visits: [VISIT], totalVisits: 412 })
    render(await Page(props('2099-07-02')))
    expect(screen.getByRole('link', { name: /previous day/i })).toHaveAttribute('href', '/home-collections?date=2099-07-01')
    expect(screen.getByRole('link', { name: /next day/i })).toHaveAttribute('href', '/home-collections?date=2099-07-03')
    expect(screen.getByText('Showing the first 1 of 412 visits for this day.')).toBeInTheDocument()
  })
})
