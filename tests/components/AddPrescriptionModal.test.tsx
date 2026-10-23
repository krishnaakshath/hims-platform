import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AddPrescriptionModal } from '@/components/AddPrescriptionModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
afterEach(() => { vi.unstubAllGlobals() })

const catalog = [{ id: 7, name: 'Amoxil', genericName: 'Amoxicillin', medicationClass: 'Antibiotic', commonDose: '500 mg', form: 'capsule' as const, quantityOnHand: 5, reorderThreshold: 1, unit: 'cap' }]
const conflictBody = { error: 'This prescription conflicts with a recorded allergy.', code: 'allergy_conflict', conflicts: [{ allergen: 'Penicillin', severity: 'severe', matchedOn: 'cross_reactivity' }] }

function setup() {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
  vi.stubGlobal('fetch', fetchMock)
  render(<AddPrescriptionModal patientId="RD-1" catalog={catalog} activeProviders={[]} needsOnBehalfOf={false} diagnosisCodes={[]} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Medication'), { target: { value: '7' } })
  return fetchMock
}
const save = () => screen.getByRole('button', { name: 'Save prescription' })

describe('AddPrescriptionModal (WS1 T7)', () => {
  it('requires a dose', () => {
    setup()
    expect(save()).toBeEnabled()
    fireEvent.change(screen.getByLabelText('Dose'), { target: { value: '' } })
    expect(save()).toBeDisabled()
  })

  it('a pattern chip sends dosePattern and its per-day count', async () => {
    const fetchMock = setup()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 4 }), { status: 201 }))
    fireEvent.click(screen.getByRole('button', { name: '1-0-1' }))
    fireEvent.click(save())
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toMatchObject({ dosePattern: '1-0-1', frequencyPerDay: 2, dose: '500 mg' })
  })

  it('shows an allergy conflict from a 422, blocks save until a reason is typed, then sends the reason', async () => {
    const fetchMock = setup()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(conflictBody), { status: 422 }))
    fireEvent.click(save())
    expect(await screen.findByText(/Penicillin \(severe\)/)).toBeInTheDocument()
    expect(save()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Allergy override reason'), { target: { value: 'Tolerated before' } })
    expect(save()).toBeEnabled()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: 9 }), { status: 201 }))
    fireEvent.click(save())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toMatchObject({ allergyOverrideReason: 'Tolerated before' })
    expect(await screen.findByText('Prescription saved.')).toBeInTheDocument()
  })
})
