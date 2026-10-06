import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { PatientLabOrder } from '@/components/LabResultsSection'
import { LabResultsSection } from '@/components/LabResultsSection'
import type { LabTestOption } from '@/components/OrderLabTestModal'
import { OrderLabTestModal } from '@/components/OrderLabTestModal'
import { EnterLabResultModal } from '@/components/EnterLabResultModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

function makeOrder(overrides: Partial<PatientLabOrder> = {}): PatientLabOrder {
  return {
    id: 1,
    status: 'ordered',
    orderedAt: new Date('2026-09-01T10:00:00Z'),
    collectedAt: null,
    testId: 1,
    testName: 'Chest X-Ray, 2 Views',
    testCode: 'XR-CHEST-2V',
    category: 'imaging',
    defaultUnit: null,
    referenceRange: null,
    attachments: [],
    result: null,
    ...overrides,
  }
}

const CHEST_ATTACHMENT = {
  id: 101,
  name: 'chest-ap.jpg',
  fileUrl: 'https://blob.example/chest-ap.jpg',
  fileType: 'JPG',
  filedAt: new Date('2026-09-01T12:00:00Z'),
  filedByName: 'Test Admin',
}

describe('LabResultsSection — imaging on the Medical Record page', () => {
  it('renders an imaging impression with its flag pill and no unit or reference range', () => {
    render(
      <LabResultsSection
        patientId="RD-0001"
        canOrder={false}
        labTests={[]}
        orders={[
          makeOrder({
            status: 'resulted',
            result: {
              value: 'No acute cardiopulmonary process.',
              unit: null,
              referenceRange: null,
              flag: 'normal',
              resultedByName: 'Dr. Test Provider',
              resultedAt: new Date('2026-09-01T13:00:00Z'),
              notes: null,
            },
          }),
        ]}
      />
    )
    expect(screen.getByText('No acute cardiopulmonary process.')).toBeInTheDocument()
    expect(screen.getByText('Normal')).toBeInTheDocument()
  })

  it("renders a thumbnail strip under a resulted imaging order", () => {
    render(
      <LabResultsSection
        patientId="RD-0001"
        canOrder={false}
        labTests={[]}
        orders={[
          makeOrder({
            status: 'resulted',
            attachments: [CHEST_ATTACHMENT],
            result: {
              value: 'No acute cardiopulmonary process.',
              unit: null,
              referenceRange: null,
              flag: 'normal',
              resultedByName: 'Dr. Test Provider',
              resultedAt: new Date('2026-09-01T13:00:00Z'),
              notes: null,
            },
          }),
        ]}
      />
    )
    const link = screen.getByRole('link', { name: /chest-ap\.jpg/ })
    expect(link.getAttribute('href')).toBe('/api/documents/101/download')
  })

  it('renders a thumbnail strip on a pending imaging order that already has attachments', () => {
    render(
      <LabResultsSection
        patientId="RD-0001"
        canOrder={false}
        labTests={[]}
        orders={[makeOrder({ status: 'ordered', attachments: [CHEST_ATTACHMENT] })]}
      />
    )
    const link = screen.getByRole('link', { name: /chest-ap\.jpg/ })
    expect(link.getAttribute('href')).toBe('/api/documents/101/download')
  })

  it('renders no strip for a pending order with no attachments', () => {
    render(
      <LabResultsSection
        patientId="RD-0001"
        canOrder={false}
        labTests={[]}
        orders={[makeOrder({ status: 'ordered', attachments: [] })]}
      />
    )
    expect(screen.queryAllByRole('link')).toEqual([])
  })

  it("groups the order modal's options into Labs and Imaging optgroups", () => {
    const labTests: LabTestOption[] = [
      { id: 1, name: 'Complete Blood Count', code: 'CBC', defaultUnit: null, referenceRange: null, category: 'lab' },
      { id: 2, name: 'Chest X-Ray, 2 Views', code: 'XR-CHEST-2V', defaultUnit: null, referenceRange: null, category: 'imaging' },
    ]
    render(<OrderLabTestModal patientId="RD-0001" labTests={labTests} onClose={vi.fn()} />)
    const select = screen.getByLabelText('Lab test')
    const optgroups = select.querySelectorAll('optgroup')
    expect(optgroups).toHaveLength(2)
    const labels = Array.from(optgroups).map((g) => g.getAttribute('label'))
    expect(labels).toEqual(expect.arrayContaining(['Labs', 'Imaging']))

    const imagingGroup = Array.from(optgroups).find((g) => g.getAttribute('label') === 'Imaging')!
    expect(imagingGroup.textContent).toContain('XR-CHEST-2V')
  })
})

describe('EnterLabResultModal — Impression mode for imaging', () => {
  it('labels the result field Impression and hides unit/reference range for category "imaging"', () => {
    render(
      <EnterLabResultModal
        orderId={1}
        testName="Chest X-Ray, 2 Views"
        defaultUnit={null}
        defaultReferenceRange={null}
        category="imaging"
        attachments={[]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Impression').tagName).toBe('TEXTAREA')
    expect(screen.queryByLabelText('Unit')).toBeNull()
    expect(screen.queryByLabelText('Reference range')).toBeNull()
  })

  it('keeps the Result value input and unit/reference range for category "lab"', () => {
    render(
      <EnterLabResultModal
        orderId={1}
        testName="Complete Blood Count"
        defaultUnit="cells/uL"
        defaultReferenceRange="4.5-11.0"
        category="lab"
        attachments={[]}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByLabelText('Result value').tagName).toBe('INPUT')
    expect(screen.getByLabelText('Unit')).toBeInTheDocument()
    expect(screen.getByLabelText('Reference range')).toBeInTheDocument()
  })

  it("lists the order's existing attachments inside the result modal", () => {
    render(
      <EnterLabResultModal
        orderId={1}
        testName="Chest X-Ray, 2 Views"
        defaultUnit={null}
        defaultReferenceRange={null}
        category="imaging"
        attachments={[CHEST_ATTACHMENT]}
        onClose={vi.fn()}
      />
    )
    const link = screen.getByRole('link', { name: /chest-ap\.jpg/ })
    expect(link.getAttribute('href')).toBe('/api/documents/101/download')
  })
})
