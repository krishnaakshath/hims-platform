import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals() })

const MED = {
  id: 3, name: 'Paracetamol 500 mg', genericName: null, medicationClass: 'Analgesic', commonDose: null, form: 'tablet' as const, quantityOnHand: 100, reorderThreshold: 10, unit: 'tablets',
  mrpPerUnitPaise: 350, gstRateBp: 1200, hsn: null, effectiveGstRateBp: 1200, // WS2 T8
}
const AMOX = { ...MED, id: 4, name: 'Amoxicillin 500 mg', genericName: 'Amoxicillin', medicationClass: 'Antibiotic' }

function okDispense(body: unknown = { id: 9, charge: { lineId: 7, quantity: 15, unitMrpPaise: 350, totalPaise: 5242 }, message: 'Dispensed 15 tablets. ₹52.42 added to the bill.' }) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => (
    url.startsWith('/api/patients/lookup')
      ? new Response(JSON.stringify({ results: [{ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 36 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
      : new Response(JSON.stringify(body), { status: 201 })
  ))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const sentBody = (fetchMock: ReturnType<typeof okDispense>) => {
  const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/pharmacy/dispense')!
  return JSON.parse(init!.body as string)
}
function fillBatch() {
  fireEvent.change(screen.getByLabelText(/batch number/i), { target: { value: 'B1234' } })
  fireEvent.change(screen.getByLabelText(/expiry month/i), { target: { value: '2099-12' } })
}

// Wave C P0-04: a stock-table dispense picks the patient by name/UHID/mobile.
describe('DispenseMedicationModal', () => {
  it('dispenses to the patient picked in the PatientPicker', async () => {
    const fetchMock = okDispense()
    render(<DispenseMedicationModal medication={MED} onClose={vi.fn()} />)
    expect(screen.queryByPlaceholderText(/RD-0001/)).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'UH000' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '10' } })
    fillBatch()
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/pharmacy/dispense')).toBe(true))
    expect(sentBody(fetchMock)).toMatchObject({ patientId: 'RD-0001', medicationId: 3, quantity: 10, batchNo: 'B1234', expiryMonth: '2099-12' })
  })

  it('keeps a patient fixed by the lookup screen read-only', () => {
    render(<DispenseMedicationModal medication={MED} initialPatientId="RD-0001" onClose={vi.fn()} />)
    expect(screen.queryByRole('combobox', { name: /patient/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText(/^patient$/i)).toHaveAttribute('readonly')
  })

  // WS2 T8
  it('pre-fills the prescribed quantity and shows unit MRP × quantity and the GST-inclusive total', () => {
    render(<DispenseMedicationModal medication={MED} initialPatientId="RD-0001" prescribedQuantity={15} onClose={vi.fn()} />)
    expect(screen.getByLabelText(/quantity/i)).toHaveValue(15)
    const price = screen.getByTestId('dispense-price')
    expect(price).toHaveTextContent('₹3.50 × 15')
    expect(price).toHaveTextContent('GST included')
    expect(price).toHaveTextContent('₹52.42')
  })

  it('needs batch and expiry before a charged dispense', () => {
    okDispense()
    render(<DispenseMedicationModal medication={MED} initialPatientId="RD-0001" prescribedQuantity={15} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Dispense' })).toBeDisabled()
    fillBatch()
    expect(screen.getByRole('button', { name: 'Dispense' })).toBeEnabled()
  })

  it('an unpriced medicine can only be dispensed free of charge with a reason', async () => {
    const fetchMock = okDispense({ id: 9, charge: null, message: 'Dispensed 2 tablets at no charge.' })
    render(<DispenseMedicationModal medication={{ ...MED, mrpPerUnitPaise: null }} initialPatientId="RD-0001" prescribedQuantity={2} onClose={vi.fn()} />)
    expect(screen.getByText(/no price \(MRP\) set/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dispense' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/dispense free of charge/i))
    fireEvent.change(screen.getByLabelText(/reason for no charge/i), { target: { value: 'Free sample' } })
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    await screen.findByText('Dispensed 2 tablets at no charge.')
    expect(sentBody(fetchMock)).toMatchObject({ noChargeReason: 'Free sample', quantity: 2 })
    expect(sentBody(fetchMock)).not.toHaveProperty('batchNo')
  })

  it('shows an allergy banner and needs the acknowledgement before dispensing', async () => {
    const fetchMock = okDispense()
    render(<DispenseMedicationModal medication={AMOX} initialPatientId="RD-0001" prescribedQuantity={15} allergies={[{ allergen: 'Penicillin', severity: 'severe' }]} onClose={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/penicillin/i)
    fillBatch()
    expect(screen.getByRole('button', { name: 'Dispense' })).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/i have checked this allergy/i))
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/pharmacy/dispense')).toBe(true))
    expect(sentBody(fetchMock)).toMatchObject({ allergyAcknowledged: true })
  })

  it('shows the conflicts the server returns (409) and the acknowledgement box', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This medicine conflicts with a recorded allergy', code: 'allergy_conflict', conflicts: [{ allergen: 'Sulfa', severity: 'moderate', matchedOn: 'class' }] }), { status: 409 })))
    render(<DispenseMedicationModal medication={MED} initialPatientId="RD-0001" prescribedQuantity={15} onClose={vi.fn()} />)
    fillBatch()
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    expect(await screen.findByLabelText(/i have checked this allergy/i)).toBeInTheDocument()
    expect(screen.getAllByRole('alert').some((a) => /sulfa/i.test(a.textContent ?? ''))).toBe(true)
  })

  it('on success shows the message and a Bill now link to the cash desk', async () => {
    const onDispensed = vi.fn()
    okDispense()
    render(<DispenseMedicationModal medication={MED} initialPatientId="RD-0001" prescribedQuantity={15} onClose={vi.fn()} onDispensed={onDispensed} />)
    fillBatch()
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Dispensed 15 tablets. ₹52.42 added to the bill.')
    expect(screen.getByRole('link', { name: /bill now/i })).toHaveAttribute('href', '/cash-desk?patientId=RD-0001')
    expect(onDispensed).toHaveBeenCalled()
  })

  // Fix round 1: a 409's conflicts and the acknowledgement belong to that patient and medicine only.
  it('clears the server allergy banner and the acknowledgement when the patient changes', async () => {
    const people = [
      { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 36 },
      { id: 'RD-0002', name: 'Ravi Kumar', uhid: 'UH00000043', gender: 'male', ageYears: 40 },
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.startsWith('/api/patients/lookup')
        ? new Response(JSON.stringify({ results: people, page: 1, pageSize: 10, hasMore: false }), { status: 200 })
        : new Response(JSON.stringify({ error: 'This medicine conflicts with an allergy on record.', code: 'allergy_conflict', conflicts: [{ allergen: 'Sulfa', severity: 'moderate', matchedOn: 'class' }] }), { status: 409 })
    )))
    render(<DispenseMedicationModal medication={MED} onClose={vi.fn()} />)
    const pick = async (name: RegExp) => {
      fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'UH000' } })
      fireEvent.click(await screen.findByRole('option', { name }))
    }
    await pick(/asha rao/i)
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '10' } })
    fillBatch()
    fireEvent.click(screen.getByRole('button', { name: 'Dispense' }))
    fireEvent.click(await screen.findByLabelText(/i have checked this allergy/i))
    expect(screen.getByRole('button', { name: 'Dispense' })).toBeEnabled()

    // Another patient: no Sulfa banner, no carried-over acknowledgement.
    fireEvent.click(screen.getByRole('button', { name: /change patient/i }))
    await pick(/ravi kumar/i)
    expect(screen.queryByLabelText(/i have checked this allergy/i)).not.toBeInTheDocument()
    expect(screen.queryAllByRole('alert').some((a) => /sulfa/i.test(a.textContent ?? ''))).toBe(false)
  })
})

