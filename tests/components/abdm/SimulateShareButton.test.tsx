import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
import { SimulateShareButton } from '@/components/abdm/SimulateShareButton'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); refresh.mockClear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SimulateShareButton', () => {
  it('posts the typed values, shows the sandbox label, and refreshes the queue', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { shareId: 4, tokenNumber: 2 }))
    render(<SimulateShareButton />)
    expect(screen.getByText('Sandbox mock - not real')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Wrong Person' } })
    fireEvent.click(screen.getByRole('button', { name: 'Simulate ABHA share' }))
    await screen.findByText(/Token 2/)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/abdm/shares/simulate')
    expect(JSON.parse(init.body)).toEqual({ counterId: 'DESK-1', name: 'Wrong Person' })
    expect(refresh).toHaveBeenCalled()
  })

  it('sends likePatientId when a chart id is typed, and shows an error', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { error: 'Not found' }))
    render(<SimulateShareButton />)
    fireEvent.change(screen.getByLabelText('Copy from patient id (optional)'), { target: { value: 'RD-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Simulate ABHA share' }))
    await screen.findByText('Not found')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ counterId: 'DESK-1', likePatientId: 'RD-1' })
  })
})
