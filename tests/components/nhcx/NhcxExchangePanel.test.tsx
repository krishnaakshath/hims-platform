import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
import { NhcxExchangePanel, type ExchangeRow } from '@/components/nhcx/NhcxExchangePanel'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ROW = (over: Partial<ExchangeRow>): ExchangeRow => ({
  id: 7, entityType: 'claim', action: 'claim/on_submit', direction: 'inbound', state: 'received', protocolStatus: 'response.complete', correlationPrefix: 'abcd1234',
  attempts: 0, lastErrorCode: null, createdAt: '2026-10-08T06:00:00.000Z', respondedAt: null, reviewState: 'pending', isMock: false, ...over,
})
const VIEW = { exchangeId: 7, reviewState: 'pending', claimId: 12, preauthId: null, dispositionText: 'Approved subject to terms', preAuthRef: null, queryText: null, isMock: false }
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => vi.unstubAllGlobals())

describe('NhcxExchangePanel', () => {
  it('confirming a response pre-fills the SP7 decision form and does not submit it', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...VIEW, action: 'claim/on_submit', summary: { outcome: 'complete', submittedPaise: 9_000_000, benefitPaise: 8_000_050, paymentAmountPaise: null, paymentDate: null }, paymentAmountPaise: null, paymentDate: null }))
    render(<NhcxExchangePanel exchanges={[ROW({})]} canAct />)
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    const approved = await screen.findByLabelText('Approved (₹)')
    expect(approved).toHaveValue('80000.50')
    expect(screen.getByText(/Approved subject to terms/)).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/rcm/nhcx/exchanges/7/payload')
    fireEvent.change(screen.getByLabelText('Decided on'), { target: { value: '2026-10-08' } })
    fetchMock.mockResolvedValueOnce(json(200, { status: 'approved' })).mockResolvedValueOnce(json(200, { reviewState: 'confirmed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Record decision' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(String(fetchMock.mock.calls[1][0])).toBe('/api/rcm/claims/12/actions')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ action: 'record_decision', approvedPaise: 8_000_050, decidedOn: '2026-10-08', disallowances: [] })
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ decision: 'confirmed' })
  })
  it('a pending payment notice offers a settlement form with the amount and an empty UTR', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ...VIEW, action: 'paymentnotice/request', summary: { outcome: null, submittedPaise: null, benefitPaise: null, paymentAmountPaise: 18_000_000, paymentDate: '2026-10-07' }, paymentAmountPaise: 18_000_000, paymentDate: '2026-10-07' }))
    render(<NhcxExchangePanel exchanges={[ROW({ action: 'paymentnotice/request', entityType: 'paymentnotice' })]} canAct />)
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(await screen.findByLabelText('Received (₹)')).toHaveValue('180000.00')
    expect(screen.getByLabelText('UTR')).toHaveValue('')
    expect(screen.getByLabelText('Payment date')).toHaveValue('2026-10-07')
  })
  it('dismiss needs a reason; a read-only viewer gets no actions; outbound rows can be status-checked', async () => {
    const { unmount } = render(<NhcxExchangePanel exchanges={[ROW({})]} canAct={false} />)
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
    unmount()
    render(<NhcxExchangePanel exchanges={[ROW({ id: 8, direction: 'outbound', action: 'claim/submit', state: 'sent', reviewState: 'not_needed' })]} canAct sendPreauthId={3} canSendPreauth={false} sendReason="NHCX not connected" />)
    expect(screen.getByRole('button', { name: 'Send via NHCX' })).toBeDisabled(); expect(screen.getByText('NHCX not connected')).toBeInTheDocument()
    fetchMock.mockResolvedValueOnce(json(200, { result: 'sent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Check status' }))
    await screen.findByText('Status requested')
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/rcm/nhcx/exchanges/8/status')
  })
})
