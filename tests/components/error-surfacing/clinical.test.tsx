// Wave H P2-09: clinical/inpatient/pharmacy mutating components surface a
// failed request in role="alert" with the fixed client message (never the
// server's 5xx text) and leave the action usable.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { CLIENT_ERROR_MESSAGES, fillAll, mockFetch, pickPatient } from './helpers'

const router = { refresh: vi.fn(), push: vi.fn() }
vi.mock('next/navigation', () => ({ useRouter: () => router }))
afterEach(() => { vi.unstubAllGlobals(); router.refresh.mockClear() })

import { AddMedicationModal } from '@/components/AddMedicationModal'
import { AddPrescriptionModal } from '@/components/AddPrescriptionModal'
import { AttachImagingModal } from '@/components/AttachImagingModal'
import { BedBoard } from '@/components/BedBoard'
import { CarePlanSection } from '@/components/CarePlanSection'
import { CheckInModal } from '@/components/CheckInModal'
import { ArchivePatientDialog } from '@/components/ArchivePatientDialog'
import { ToastProvider } from '@/components/ui/toast' // WS7 T16: the dashboard layout provides toasts
import { DischargeAdmissionModal } from '@/components/DischargeAdmissionModal'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'
import { EnterLabResultModal } from '@/components/EnterLabResultModal'
import { LabWorklist } from '@/components/LabWorklist'
import { BillLegacyDispenseButton } from '@/components/PharmacyBillingTable' // WS2 T8
import { MedicationAdministrationPanel } from '@/components/MedicationAdministrationPanel'
import { MedicationHistorySection } from '@/components/MedicationHistorySection'
import { NoteForm } from '@/components/NoteForm'
import { OrderLabTestModal } from '@/components/OrderLabTestModal'
import { TransferAdmissionModal } from '@/components/TransferAdmissionModal'
import { ToastProvider } from '@/components/ui/toast'

const LEAK = 'duplicate key value violates unique constraint "x"'
const med = { id: 1, name: 'Paracetamol', genericName: null, medicationClass: 'Analgesic', commonDose: '500mg', form: 'tablet' as const, quantityOnHand: 10, reorderThreshold: 2, unit: 'tab', mrpPerUnitPaise: 350, gstRateBp: null, hsn: null, effectiveGstRateBp: 500 /* WS2 T8 */, batches: [], nearestExpiry: null, expiringSoonQty: 0, expiredQty: 0 }

type Case = { name: string; ui: () => ReactElement; before?: () => Promise<void> | void; submit: RegExp; status?: number }
const CASES: Case[] = [
  { name: 'AddMedicationModal', ui: () => <AddMedicationModal onClose={vi.fn()} />, submit: /^Add medication$/ },
  { name: 'AttachImagingModal', ui: () => <AttachImagingModal orderId={1} testName="X-ray" onClose={vi.fn()} />,
    before: () => { fireEvent.change(screen.getByLabelText('Imaging file'), { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } }) }, submit: /^Attach image$/ },
  // SP5: a multi-test checklist; ticking the one test enables "Order 1 test".
  { name: 'OrderLabTestModal', ui: () => <OrderLabTestModal patientId="RD-1" labTests={[{ id: 3, name: 'CBC', code: 'CBC', category: 'lab' } as never]} onClose={vi.fn()} />,
    before: () => { fireEvent.click(screen.getByRole('checkbox', { name: /CBC/ })) }, submit: /^Order 1 test$/ },
  { name: 'TransferAdmissionModal', ui: () => <TransferAdmissionModal admissionId={1} availableRooms={[{ id: 2, ward: 'A', roomNumber: '1', bedNumber: 'B' }]} onClose={vi.fn()} />, submit: /^Transfer$/ },
  { name: 'DispenseMedicationModal', ui: () => <DispenseMedicationModal medication={med} onClose={vi.fn()} />, submit: /^Dispense$/,
    // WS2 T8: a charged dispense needs an expiry month (fillAll cannot type a month input).
    before: async () => { await pickPatient(); fireEvent.change(screen.getByLabelText('Expiry month'), { target: { value: '2099-12' } }) } },
  { name: 'EnterLabResultModal', ui: () => <EnterLabResultModal orderId={1} testName="CBC" defaultUnit="g/dL" defaultReferenceRange="12-16" category="lab" attachments={[]} onClose={vi.fn()} />, submit: /^Save result$/ },
  { name: 'ArchivePatientDialog', ui: () => <ToastProvider><ArchivePatientDialog target={{ id: 'RD-1', name: 'P', uhid: 'UH-000001' }} onClose={vi.fn()} onArchived={vi.fn()} /></ToastProvider>,
    before: () => { fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Duplicate registration' } }) }, submit: /^Archive patient$/ },
  // WS6 T9: department then doctor; the success toast needs a ToastProvider.
  { name: 'CheckInModal', ui: () => <ToastProvider><CheckInModal providers={[{ id: 1, name: 'Dr A', departmentId: 1 }]} departments={[{ id: 1, name: 'General Medicine' }]} initialPatient={{ id: 'RD-1', name: 'P', uhid: null }} onClose={vi.fn()} /></ToastProvider>, submit: /^Check In$/ },
  { name: 'NoteForm', ui: () => <NoteForm patientId="RD-1" canWrite />, before: () => { fireEvent.click(screen.getByRole('button', { name: /new note/i })) }, submit: /^(Save|Create)/ },
  { name: 'CarePlanSection', ui: () => <CarePlanSection patientId="RD-1" plans={[]} canWrite />, before: () => { fireEvent.click(screen.getByRole('button', { name: 'New Care Plan' })) }, submit: /^Save$/ },
  { name: 'BedBoard block', ui: () => <BedBoard rooms={[{ id: 5, ward: 'A', roomNumber: '1', bedNumber: 'B', status: 'available', blockedReason: null, occupantName: null, occupantPatientId: null, attendingProviderName: null, admittedAt: null,
    admissionId: null, occupantUhid: null, occupantGender: null, genderRestriction: null, roomCategoryName: null, bedTariffPaise: null, daysStayed: null, wardGenderOverride: false }]}
    availableRooms={[]} canManageFacilities canBlock canAdmit={false} canTransfer={false} canDischarge={false} canManageMedications={false} canCaptureCharges={false} />,
    before: () => { fireEvent.click(screen.getByRole('button', { name: /1/ })) }, submit: /^Block room$/ },
  { name: 'LabWorklist collect', ui: () => <LabWorklist role="labs" labTests={[]} orders={[{ id: 9, status: 'ordered', orderedAt: new Date(), collectedAt: null, patientId: 'RD-1', patientName: 'P', testId: 1, testName: 'CBC', testCode: 'CBC', category: 'lab', attachments: [], orderedByProviderId: 1, orderedByProviderName: 'Dr',
    sampleId: null, requisitionId: 1, homeCollectionVisitId: null, visitDate: null, receivedAt: null, verifiedAt: null, patientUhid: null, result: null }]} />, submit: /^Mark collected$/ },
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
    // WS3 T6: the dues step first; its context load fails too, and the doctor may still go on (the server gates dues).
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.network)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    for (const label of ['Diagnosis', 'Drugs', 'Devices', 'Diet', 'Discharge summary notes']) fireEvent.change(screen.getByLabelText(label), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Next'))
    fireEvent.change(screen.getByLabelText('Typed signature'), { target: { value: 'Dr. Chen' } })
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.click(screen.getByRole('button', { name: 'Discharge' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.network)
    expect(screen.getByRole('button', { name: 'Discharge' })).toBeEnabled()
  })
})

describe('BillLegacyDispenseButton', () => { // WS2 T8
  it('shows the 409 already-billed message', async () => {
    mockFetch(409, { error: 'This dispense has already been billed' })
    render(<BillLegacyDispenseButton dispenseId={1} onBilled={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bill at current price' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already been billed')
    expect(screen.getByRole('button', { name: 'Bill at current price' })).toBeEnabled()
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
    const episode = { id: 1, patientId: 'RD-1', name: 'X', medicationClass: 'Y', dose: null, startDate: '2026-01-01', stopDate: null, status: 'active', medicationId: null, frequencyPerDay: null, durationDays: null, instructions: null, prescribedByProviderId: null, enteredByName: null, prescribedAt: null, prescriptionId: null, dosePattern: null, route: null, foodTiming: null, isSos: false, quantityPrescribed: null, allergyOverrideReason: null } as const
    render(<MedicationHistorySection patientId="RD-1" episodes={[episode]} prescriberById={{}} catalog={[]} specialties={[]} activeProviders={[]} needsOnBehalfOf={false} diagnosisCodes={[]} canPrescribe />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })
})

import { PharmacyBillingTable } from '@/components/PharmacyBillingTable'

describe('PharmacyBillingTable', () => {
  // WS2 T8: billing a legacy dispense at the current price; a 500 shows the fixed message.
  it('shows a failed bill instead of silently doing nothing', async () => {
    mockFetch(500, { error: LEAK })
    render(<PharmacyBillingTable rows={[{ dispenseId: 1, patientId: 'RD-1', patientName: 'P', uhid: null, medicationName: 'X', quantity: 1, dispensedByName: 'Ph', dispensedAt: '2026-10-08T04:00:00Z', billing: { status: 'unbilled' } }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bill at current price' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(screen.getByRole('button', { name: 'Bill at current price' })).toBeEnabled()
  })
})
