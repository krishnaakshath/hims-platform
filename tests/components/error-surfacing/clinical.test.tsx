// Wave H P2-09: clinical/inpatient/pharmacy mutating components surface a
// failed request in role="alert" with the fixed client message (never the
// server's 5xx text) and leave the action usable.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { CLIENT_ERROR_MESSAGES, fillAll, mockFetch } from './helpers'

const router = { refresh: vi.fn(), push: vi.fn() }
vi.mock('next/navigation', () => ({ useRouter: () => router }))
afterEach(() => { vi.unstubAllGlobals(); router.refresh.mockClear() })

import { AddMedicationModal } from '@/components/AddMedicationModal'
import { AddPrescriptionModal } from '@/components/AddPrescriptionModal'
import { AttachImagingModal } from '@/components/AttachImagingModal'
import { BedBoard } from '@/components/BedBoard'
import { CarePlanSection } from '@/components/CarePlanSection'
import { CheckInModal } from '@/components/CheckInModal'
import { DeletePatientDialog } from '@/components/DeletePatientDialog'
import { DischargeAdmissionModal } from '@/components/DischargeAdmissionModal'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'
import { EnterLabResultModal } from '@/components/EnterLabResultModal'
import { LabWorklist } from '@/components/LabWorklist'
import { LogDispenseBillModal } from '@/components/LogDispenseBillModal'
import { MedicationAdministrationPanel } from '@/components/MedicationAdministrationPanel'
import { MedicationHistorySection } from '@/components/MedicationHistorySection'
import { NoteForm } from '@/components/NoteForm'
import { OrderLabTestModal } from '@/components/OrderLabTestModal'
import { TransferAdmissionModal } from '@/components/TransferAdmissionModal'

const LEAK = 'duplicate key value violates unique constraint "x"'
const med = { id: 1, name: 'Paracetamol', genericName: null, medicationClass: 'Analgesic', commonDose: '500mg', form: 'tablet' as const, quantityOnHand: 10, reorderThreshold: 2, unit: 'tab' }

type Case = { name: string; ui: () => ReactElement; before?: () => Promise<void> | void; submit: RegExp; status?: number }
const CASES: Case[] = [
  { name: 'AddMedicationModal', ui: () => <AddMedicationModal onClose={vi.fn()} />, submit: /^Add medication$/ },
  { name: 'AttachImagingModal', ui: () => <AttachImagingModal orderId={1} testName="X-ray" onClose={vi.fn()} />,
    before: () => { fireEvent.change(screen.getByLabelText('Imaging file'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } }) }, submit: /^Attach image$/ },
  { name: 'OrderLabTestModal', ui: () => <OrderLabTestModal patientId="RD-1" labTests={[{ id: 3, name: 'CBC', code: 'CBC', category: 'lab' } as never]} onClose={vi.fn()} />, submit: /^Order test$/ },
  { name: 'TransferAdmissionModal', ui: () => <TransferAdmissionModal admissionId={1} availableRooms={[{ id: 2, ward: 'A', roomNumber: '1', bedNumber: 'B' }]} onClose={vi.fn()} />, submit: /^Transfer$/ },
  { name: 'DispenseMedicationModal', ui: () => <DispenseMedicationModal medication={med} onClose={vi.fn()} />, submit: /^Dispense$/ },
  { name: 'EnterLabResultModal', ui: () => <EnterLabResultModal orderId={1} testName="CBC" defaultUnit="g/dL" defaultReferenceRange="12-16" category="lab" attachments={[]} onClose={vi.fn()} />, submit: /^Save result$/ },
  { name: 'DeletePatientDialog', ui: () => <DeletePatientDialog target={{ id: 'RD-1', name: 'P' }} onClose={vi.fn()} onDeleted={vi.fn()} />, submit: /delete/i },
  { name: 'CheckInModal', ui: () => <CheckInModal providers={[{ id: 1, name: 'Dr A' }]} rooms={[]} onClose={vi.fn()} />, submit: /^Check In$/ },
  { name: 'NoteForm', ui: () => <NoteForm patientId="RD-1" canWrite />, before: () => { fireEvent.click(screen.getByRole('button', { name: /new note/i })) }, submit: /^(Save|Create)/ },
  { name: 'CarePlanSection', ui: () => <CarePlanSection patientId="RD-1" plans={[]} canWrite />, before: () => { fireEvent.click(screen.getByRole('button', { name: 'New Care Plan' })) }, submit: /^Save$/ },
  { name: 'BedBoard block', ui: () => <BedBoard rooms={[{ id: 5, ward: 'A', roomNumber: '1', bedNumber: 'B', status: 'available', blockedReason: null, occupantName: null, occupantPatientId: null, attendingProviderName: null, admittedAt: null }]} canManageFacilities canBlock canAdmit={false} />,
    before: () => { fireEvent.click(screen.getByRole('button', { name: /1/ })) }, submit: /^Block room$/ },
  { name: 'LabWorklist collect', ui: () => <LabWorklist role="labs" labTests={[]} orders={[{ id: 9, status: 'ordered', orderedAt: new Date(), collectedAt: null, patientId: 'RD-1', patientName: 'P', testId: 1, testName: 'CBC', testCode: 'CBC', category: 'lab', attachments: [], orderedByProviderId: 1, orderedByProviderName: 'Dr' }]} />, submit: /^Mark collected$/ },
]

describe.each(CASES)('$name', (c) => {
  it('shows a failed save in an alert with the fixed message and keeps the action enabled', async () => {
    mockFetch(c.status ?? 500, { error: LEAK })
    render(c.ui())
    await c.before?.()
    await fillAll()
    const button = screen.getAllByRole('button', { name: c.submit }).at(-1)!
    expect(button).toBeEnabled()
    fireEvent.click(button)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(alert).not.toHaveTextContent('duplicate key')
    await waitFor(() => expect(screen.getAllByRole('button', { name: c.submit }).at(-1)).toBeEnabled())
    expect(router.refresh).not.toHaveBeenCalled()
  })
})

describe('AddPrescriptionModal', () => {
  it('shows the route\'s 400 message in an alert', async () => {
    mockFetch(400, { error: 'Choose the doctor who prescribes this.' })
    render(<AddPrescriptionModal patientId="RD-1" catalog={[]} activeProviders={[]} needsOnBehalfOf={false} diagnosisCodes={[]} onClose={vi.fn()} />)
    const offCatalog = screen.queryByRole('checkbox')
    if (offCatalog) fireEvent.click(offCatalog)
    await fillAll()
    const save = screen.getAllByRole('button').find((b) => /save|prescribe/i.test(b.textContent ?? ''))!
    fireEvent.click(save)
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose the doctor who prescribes this.')
  })
})

describe('DischargeAdmissionModal', () => {
  it('shows a network failure from the signature step', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    render(<DischargeAdmissionModal admissionId={1} onClose={vi.fn()} />)
    for (const label of ['Diagnosis', 'Drugs', 'Devices', 'Diet', 'Discharge summary notes']) fireEvent.change(screen.getByLabelText(label), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Next'))
    fireEvent.change(screen.getByLabelText('Typed signature'), { target: { value: 'Dr. Chen' } })
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.click(screen.getByRole('button', { name: 'Discharge' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.network)
    expect(screen.getByRole('button', { name: 'Discharge' })).toBeEnabled()
  })
})

describe('LogDispenseBillModal', () => {
  it('shows the 409 already-billed message', async () => {
    mockFetch(409, { error: 'This dispense has already been billed' })
    render(<LogDispenseBillModal dispense={{ id: 1, patientId: 'RD-1', medicationName: 'X', quantity: 2 } as never} diagnoses={[{ id: 1, code: 'J00', description: 'Cold' }] as never} onClose={vi.fn()} />)
    await fillAll()
    const button = screen.getAllByRole('button').find((b) => /log|bill/i.test(b.textContent ?? '') && !/cancel/i.test(b.textContent ?? ''))!
    fireEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent('already been billed')
  })
})

describe('MedicationAdministrationPanel', () => {
  it('shows a failed add in an alert after a successful load', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      !init || !init.method || init.method === 'GET'
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ error: LEAK }), { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<MedicationAdministrationPanel admissionId={1} onClose={vi.fn()} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await fillAll()
    fireEvent.click(screen.getByRole('button', { name: 'Add medication' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})

describe('MedicationHistorySection', () => {
  it('shows a failed stop in an alert', async () => {
    mockFetch(500, { error: LEAK })
    const episode = { id: 1, patientId: 'RD-1', name: 'X', medicationClass: 'Y', dose: null, startDate: '2026-01-01', stopDate: null, status: 'active', medicationId: null, frequencyPerDay: null, durationDays: null, instructions: null, prescribedByProviderId: null, enteredByName: null, prescribedAt: null } as const
    render(<MedicationHistorySection patientId="RD-1" episodes={[episode]} prescriberById={{}} catalog={[]} specialties={[]} activeProviders={[]} needsOnBehalfOf={false} diagnosisCodes={[]} canPrescribe />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})

import { PharmacyBillingTable } from '@/components/PharmacyBillingTable'

describe('PharmacyBillingTable', () => {
  it('shows a failed chart load instead of silently doing nothing', async () => {
    mockFetch(500, { error: LEAK })
    render(<PharmacyBillingTable rows={[{ dispenseId: 1, patientId: 'RD-1', patientName: 'P', medicationName: 'X', quantity: 1, dispensedByName: 'Ph', dispensedAt: '2026-10-08T04:00:00Z', charge: null }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Log bill' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(screen.getByRole('button', { name: 'Log bill' })).toBeEnabled()
  })
})
