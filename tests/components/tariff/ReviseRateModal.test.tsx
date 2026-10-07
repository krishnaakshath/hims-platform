import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ReviseRateModal } from '@/components/tariff/ReviseRateModal'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const rate = { id: 7, amountPaise: 50000, validFrom: '2026-01-01', validTo: null }

describe('ReviseRateModal', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('summarises the revision and POSTs paise to /revise', async () => {
    const onClose = vi.fn()
    render(<ReviseRateModal rate={rate} today="2026-10-07" onClose={onClose} />)
    fireEvent.change(screen.getByLabelText('New amount (₹)'), { target: { value: '1,250.50' } })
    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2026-11-01' } })
    expect(screen.getByText('Current ₹500.00 until 31 Oct 2026, new ₹1,250.50 from 1 Nov 2026')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revision' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tariff/rates/7/revise')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ amountPaise: 125050, effectiveFrom: '2026-11-01' })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('shows the server 400 message verbatim', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'The new amount equals the current amount' }), { status: 400 }))
    render(<ReviseRateModal rate={rate} today="2026-10-07" onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('New amount (₹)'), { target: { value: '500' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revision' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The new amount equals the current amount')
  })

  it('rejects an invalid amount client-side without calling the API', async () => {
    render(<ReviseRateModal rate={rate} today="2026-10-07" onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('New amount (₹)'), { target: { value: '12.345' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm revision' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/valid amount/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
