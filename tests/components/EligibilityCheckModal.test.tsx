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
    if (u.startsWith('/api/patients/lookup')) return json({ results: [
      { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 36 },
      { id: 'RD-0002', name: 'Ravi Kumar', uhid: null, gender: 'male', ageYears: 51 },
    ], page: 1, pageSize: 10, hasMore: false })
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

    // Wave C P0-04: billing picks the patient by name, UHID or mobile.
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'asha' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))

    await waitFor(() => expect((screen.getByLabelText('Payer') as HTMLSelectElement).value).toBe('9'))
    expect(requestedUrls()).toContain('/api/patients/RD-0001/primary-payer')
    // Never the full patient-detail JSON route (clinical; admin/crc/pi only);
    // the picker's /api/patients/lookup is the minimal projection.
    expect(requestedUrls().some((u) => /^\/api\/patients\/(?!lookup\?)[^/]+$/.test(u))).toBe(false)
  })

  it('stays quiet and leaves the payer unselected when the lookup fails', async () => {
    render(<EligibilityCheckModal onClose={vi.fn()} />)
    await screen.findByRole('option', { name: 'Blue Plan' })

    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'ravi' } })
    fireEvent.click(await screen.findByRole('option', { name: /ravi kumar/i }))

    await waitFor(() => expect(requestedUrls()).toContain('/api/patients/RD-0002/primary-payer'))
    expect((screen.getByLabelText('Payer') as HTMLSelectElement).value).toBe('')
    expect(screen.queryByText(/forbidden/i)).toBeNull()
  })
})
