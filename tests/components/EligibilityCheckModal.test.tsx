import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { EligibilityCheckModal } from '@/components/EligibilityCheckModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const PAYERS = [{ id: 7, name: 'Acme Health' }, { id: 9, name: 'Blue Plan' }]

let fetchMock: ReturnType<typeof vi.fn>

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const u = String(input)
    if (u === '/api/payers') return json(PAYERS)
    if (u === '/api/patients/RD-0001/primary-payer') return json({ primaryPayerId: 9 })
    if (u === '/api/patients/RD-0002/primary-payer') return json({ error: 'Forbidden' }, 403)
    return json({ error: 'unexpected' }, 500)
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const requestedUrls = () => fetchMock.mock.calls.map((c) => String(c[0]))

describe('EligibilityCheckModal payer prefill', () => {
  it('looks up the payer via /primary-payer and prefills the dropdown', async () => {
    render(<EligibilityCheckModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'Blue Plan' })

    const input = screen.getByLabelText('Patient ID')
    fireEvent.change(input, { target: { value: 'RD-0001' } })
    fireEvent.blur(input)

    await waitFor(() => expect((screen.getByLabelText('Payer') as HTMLSelectElement).value).toBe('9'))
    expect(requestedUrls()).toContain('/api/patients/RD-0001/primary-payer')
    // Never the full patient-detail JSON route (clinical; admin/crc/pi only).
    expect(requestedUrls().some((u) => /^\/api\/patients\/[^/]+$/.test(u))).toBe(false)
  })

  it('stays quiet and leaves the payer unselected when the lookup fails', async () => {
    render(<EligibilityCheckModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'Blue Plan' })

    const input = screen.getByLabelText('Patient ID')
    fireEvent.change(input, { target: { value: 'RD-0002' } })
    fireEvent.blur(input)

    await waitFor(() => expect(requestedUrls()).toContain('/api/patients/RD-0002/primary-payer'))
    expect((screen.getByLabelText('Payer') as HTMLSelectElement).value).toBe('')
    expect(screen.queryByText(/forbidden/i)).toBeNull()
  })
})
