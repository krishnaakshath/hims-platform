import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals() })

const MED = { id: 3, name: 'Paracetamol 500 mg', genericName: null, medicationClass: 'Analgesic', commonDose: null, form: 'tablet' as const, quantityOnHand: 100, reorderThreshold: 10, unit: 'tablets' }

// Wave C P0-04: a stock-table dispense picks the patient by name/UHID/mobile.
describe('DispenseMedicationModal', () => {
  it('dispenses to the patient picked in the PatientPicker', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
      url.startsWith('/api/patients/lookup')
        ? new Response(JSON.stringify({ results: [{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 36 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
        : new Response('{}', { status: 201 })
    ))
    vi.stubGlobal('fetch', fetchMock)
    render(<DispenseMedicationModal medication={MED} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/RD-0001/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'UH000' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/pharmacy/dispense')).toBe(true))
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/pharmacy/dispense')!
    expect(JSON.parse(init!.body as string)).toMatchObject({ patientId: 'RD-0001', medicationId: 3, quantity: 10 })
  })

  it('keeps a patient fixed by the lookup screen read-only', () => {
    render(<DispenseMedicationModal medication={MED} initialPatientId="RD-0001" onClose={vi.fn()} />)
    expect(screen.queryByRole('combobox', { name: /patient/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/patient/i)).toHaveAttribute('readonly')
  })
})
