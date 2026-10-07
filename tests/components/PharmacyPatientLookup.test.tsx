import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PharmacyPatientLookup } from '@/components/PharmacyPatientLookup'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals() })

const VIEW = { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', dob: '1990-01-01', currentProvider: null, diagnoses: [], activeMedications: [], pastMedications: [], dispenses: [] }

// Wave C P0-04: the pharmacy counter finds a patient by name, UHID or mobile.
describe('PharmacyPatientLookup', () => {
  it('looks the picked patient up by chart id and shows the UHID', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('/api/patients/lookup')) return new Response(JSON.stringify({ results: [{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 36 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
      if (url.startsWith('/api/pharmacy/patients/')) return new Response(JSON.stringify(VIEW), { status: 200 })
      return new Response('[]', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<PharmacyPatientLookup medications={[]} roster={[]} />)
    expect(screen.queryByPlaceholderText(/RD-0001/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'asha' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/pharmacy/patients/RD-0001')).toBe(true))
    expect(await screen.findByText('UH00000042')).toBeInTheDocument()
  })
})
