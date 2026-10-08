import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { EligibilityCheckPanel } from '@/components/nhcx/EligibilityCheckPanel'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const PROPS = { policyId: 4, context: 'manual' as const, providers: [{ id: 9, name: 'Dr A' }], defaultProviderId: 9, nhcxConfigured: true, payerOnNhcx: true }
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('EligibilityCheckPanel', () => {
  it('shows not configured, not on NHCX, waiting, in force and mock states', async () => {
    const { unmount } = render(<EligibilityCheckPanel {...PROPS} nhcxConfigured={false} />)
    expect(screen.getByRole('button', { name: 'Check eligibility (NHCX)' })).toBeDisabled(); expect(screen.getByText('NHCX not configured')).toBeInTheDocument()
    unmount()
    const second = render(<EligibilityCheckPanel {...PROPS} payerOnNhcx={false} />)
    expect(screen.getByText('This insurer is not on NHCX; confirm cover through the insurer portal')).toBeInTheDocument()
    second.unmount()

    render(<EligibilityCheckPanel {...PROPS} />)
    fetchMock.mockResolvedValueOnce(json(202, { checkId: 12 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check eligibility (NHCX)' })) })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ policyId: 4, purpose: 'validation', context: 'manual', providerId: 9 })
    expect(screen.getByText('Asking the insurer…')).toBeInTheDocument()
    fetchMock.mockResolvedValueOnce(json(200, { status: 'pending', isMock: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    fetchMock.mockResolvedValueOnce(json(200, { status: 'eligible', isMock: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(screen.getByText('Policy in force')).toBeInTheDocument()
    expect(screen.getByText('Sandbox mock - not real')).toBeInTheDocument()
  })
  it('gives up after two minutes with a waiting message', async () => {
    render(<EligibilityCheckPanel {...PROPS} />)
    fetchMock.mockResolvedValueOnce(json(202, { checkId: 12 }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check eligibility (NHCX)' })) })
    fetchMock.mockImplementation(async () => json(200, { status: 'pending', isMock: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(125_000) })
    expect(screen.getByText('Waiting for the insurer; check again later')).toBeInTheDocument()
  })
})
