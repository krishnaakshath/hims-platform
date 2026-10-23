import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals() })

const MED = { id: 3, name: 'Paracetamol 500 mg', genericName: null, medicationClass: 'Analgesic', commonDose: null, form: 'tablet' as const, quantityOnHand: 100, reorderThreshold: 10, unit: 'tablets', batches: [], nearestExpiry: null, expiringSoonQty: 0, expiredQty: 0 }

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

  // WS5 T5: batch select, FEFO by default, expired batches listed but disabled.
  it('defaults to the FEFO batch, disables expired batches and sends a picked batch', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const batches = [
      { id: 11, batchNo: 'OLD-9', expiryDate: '2020-01-31', quantityOnHand: 5, mrpPerUnitPaise: 900, writtenOff: false },
      { id: 12, batchNo: 'SOON-9', expiryDate: '2030-12-31', quantityOnHand: 40, mrpPerUnitPaise: 1000, writtenOff: false },
      { id: 13, batchNo: 'LATE-9', expiryDate: '2031-06-30', quantityOnHand: 60, mrpPerUnitPaise: 1250, writtenOff: false },
      { id: 14, batchNo: 'GONE-9', expiryDate: '2031-06-30', quantityOnHand: 0, mrpPerUnitPaise: 1250, writtenOff: true },
    ]
    render(<DispenseMedicationModal medication={{ ...MED, batches }} initialPatientId="RD-0001" today="2026-10-23" onClose={vi.fn()} />)
    const select = screen.getByLabelText(/batch/i) as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0].textContent).toBe('FEFO: SOON-9 · exp Dec 2030')
    expect(screen.getByRole('option', { name: /OLD-9/ })).toBeDisabled()
    expect(screen.queryByRole('option', { name: /GONE-9/ })).not.toBeInTheDocument()
    expect(screen.getByText('MRP ₹10.00 per unit')).toBeInTheDocument()

    fireEvent.change(select, { target: { value: '13' } })
    expect(screen.getByText('MRP ₹12.50 per unit')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/pharmacy/dispense')!
    expect(JSON.parse(init!.body as string)).toMatchObject({ patientId: 'RD-0001', medicationId: 3, quantity: 2, batchId: 13 })
  })

  it('sends no batchId when FEFO is left selected', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const batches = [{ id: 12, batchNo: 'SOON-9', expiryDate: '2030-12-31', quantityOnHand: 40, mrpPerUnitPaise: 1000, writtenOff: false }]
    render(<DispenseMedicationModal medication={{ ...MED, batches }} initialPatientId="RD-0001" today="2026-10-23" onClose={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).not.toHaveProperty('batchId')
  })
})
