import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { RateVersionsTable, type RateListItem } from '@/components/tariff/RateVersionsTable'
import { rateStatus } from '@/components/tariff/status'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const TODAY = '2026-10-07'
const rate = (over: Partial<RateListItem>): RateListItem => ({
  id: 1, scope: 'base', departmentName: null, payerName: null, roomCategoryCode: null, ward: null,
  amountPaise: 50000, validFrom: '2026-01-01', validTo: null, deactivated: false, ...over,
})

describe('RateVersionsTable', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    refresh.mockClear()
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('labels current, scheduled, ended and deactivated rows against today', () => {
    expect(rateStatus(rate({ validFrom: '2026-10-08' }), TODAY)).toBe('scheduled')
    expect(rateStatus(rate({ validTo: '2026-10-06' }), TODAY)).toBe('ended')
    expect(rateStatus(rate({ validTo: TODAY }), TODAY)).toBe('current') // inclusive end
    expect(rateStatus(rate({ validFrom: TODAY }), TODAY)).toBe('current') // inclusive start
    expect(rateStatus(rate({ deactivated: true, validTo: '2026-10-06' }), TODAY)).toBe('deactivated')

    render(<RateVersionsTable today={TODAY} rates={[
      rate({ id: 1 }), rate({ id: 2, validFrom: '2026-10-08', amountPaise: 60000 }),
      rate({ id: 3, validTo: '2026-10-06', amountPaise: 40000 }), rate({ id: 4, deactivated: true, amountPaise: 30000 }),
    ]} />)
    expect(within(screen.getByText('₹500.00').closest('tr')!).getByText('Current')).toBeInTheDocument()
    expect(within(screen.getByText('₹600.00').closest('tr')!).getByText('Scheduled')).toBeInTheDocument()
    expect(within(screen.getByText('₹400.00').closest('tr')!).getByText('Ended')).toBeInTheDocument()
    expect(within(screen.getByText('₹300.00').closest('tr')!).getByText('Deactivated')).toBeInTheDocument()
  })

  it('shows the payer name and room/ward for a payer rate, grouped by scope', () => {
    render(<RateVersionsTable today={TODAY} rates={[
      rate({ id: 5, scope: 'payer', payerName: 'Star Health', roomCategoryCode: 'ICU', ward: 'icu ward', amountPaise: 1250000 }),
      rate({ id: 6, scope: 'department', departmentName: 'Cardiology' }),
      rate({ id: 7, amountPaise: 99900 }),
    ]} />)
    expect(screen.getByRole('heading', { name: 'Base price' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Payer rates' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Department price list' })).toBeInTheDocument()
    expect(screen.getByText(/Star Health/)).toBeInTheDocument()
    expect(screen.getByText(/ICU/)).toBeInTheDocument()
    expect(screen.getByText(/icu ward/)).toBeInTheDocument()
    expect(screen.getByText('₹12,500.00')).toBeInTheDocument()
  })

  it('shows Revise only on current and scheduled rows', () => {
    render(<RateVersionsTable today={TODAY} rates={[rate({ id: 1 }), rate({ id: 3, validTo: '2026-10-06' }), rate({ id: 4, deactivated: true })]} />)
    expect(screen.getAllByRole('button', { name: /^Revise/ })).toHaveLength(1)
  })

  it('shows an empty state', () => {
    render(<RateVersionsTable today={TODAY} rates={[]} />)
    expect(screen.getByText(/no rates yet/i)).toBeInTheDocument()
  })

  it('confirms before deactivating and PATCHes deactivate true', async () => {
    render(<RateVersionsTable today={TODAY} rates={[rate({ id: 9 })]} />)
    fireEvent.click(screen.getByRole('button', { name: /^Deactivate/ }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate rate' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/tariff/rates/9')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ deactivate: true })
  })

  it('ends a rate on a chosen date after confirmation and shows the server error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'This rate overlaps an existing rate for the same service, scope and room/ward' }), { status: 409 }))
    render(<RateVersionsTable today={TODAY} rates={[rate({ id: 9 })]} />)
    fireEvent.click(screen.getByRole('button', { name: /^End/ }))
    fireEvent.change(await screen.findByLabelText('End date'), { target: { value: '2026-12-31' } })
    fireEvent.click(screen.getByRole('button', { name: 'End rate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('overlaps an existing rate')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ validTo: '2026-12-31' })
  })
})
