import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { WorklistOrder } from '@/components/LabWorklist'
import { LabWorklist } from '@/components/LabWorklist'
import type { Role } from '@/lib/auth'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

function makeOrder(overrides: Partial<WorklistOrder> = {}): WorklistOrder {
  return {
    id: 1,
    status: 'ordered',
    orderedAt: new Date('2026-09-01T10:00:00Z'),
    collectedAt: null,
    patientId: 'RD-0001',
    patientName: 'Test Patient',
    testId: 1,
    testName: 'Chest X-Ray, 2 Views',
    testCode: 'XR-CHEST-2V',
    category: 'imaging',
    attachments: [],
    orderedByProviderId: 1,
    orderedByProviderName: 'Dr. Test Provider',
    ...overrides,
  }
}

function renderWorklist(order: WorklistOrder, role: Role) {
  return render(<LabWorklist orders={[order]} labTests={[]} role={role} />)
}

describe('LabWorklist — imaging attach control and thumbnail strip', () => {
  it('shows Attach image on an ordered imaging row for admin', () => {
    renderWorklist(makeOrder({ status: 'ordered' }), 'admin')
    expect(screen.getByRole('button', { name: /attach image/i })).toBeInTheDocument()
  })

  it('shows Attach image on a collected imaging row for pi', () => {
    renderWorklist(makeOrder({ status: 'collected', collectedAt: new Date('2026-09-01T11:00:00Z') }), 'pi')
    expect(screen.getByRole('button', { name: /attach image/i })).toBeInTheDocument()
  })

  it('does not render Attach image for crc', () => {
    renderWorklist(makeOrder({ status: 'ordered' }), 'crc')
    expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument()
  })

  it('does not render Attach image for frontdesk', () => {
    renderWorklist(makeOrder({ status: 'ordered' }), 'frontdesk')
    expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument()
  })

  it('does not render Attach image on a lab-category row', () => {
    renderWorklist(makeOrder({ status: 'ordered', category: 'lab' }), 'admin')
    expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument()
  })

  it('does not render Attach image in the Resulted group', () => {
    renderWorklist(makeOrder({
      status: 'resulted',
      collectedAt: new Date('2026-09-01T11:00:00Z'),
    }), 'admin')
    expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument()
  })

  it('renders a thumbnail link per attachment pointing at the audited download route', () => {
    renderWorklist(makeOrder({
      status: 'collected',
      attachments: [
        { id: 101, name: 'chest-ap.jpg', fileUrl: 'https://blob.example/chest-ap.jpg', fileType: 'JPG', filedAt: new Date('2026-09-01T12:00:00Z'), filedByName: 'Test Admin' },
        { id: 102, name: 'chest-lat.jpg', fileUrl: 'https://blob.example/chest-lat.jpg', fileType: 'JPG', filedAt: new Date('2026-09-01T12:01:00Z'), filedByName: 'Test Admin' },
      ],
    }), 'admin')
    const links = screen.getAllByRole('link', { name: /chest-ap\.jpg|chest-lat\.jpg/ })
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/api/documents/101/download', '/api/documents/102/download'])
  })

  it('renders the thumbnail strip on a resulted imaging row with no action buttons', () => {
    renderWorklist(makeOrder({
      status: 'resulted',
      collectedAt: new Date('2026-09-01T11:00:00Z'),
      attachments: [
        { id: 201, name: 'chest-ap.jpg', fileUrl: 'https://blob.example/chest-ap.jpg', fileType: 'JPG', filedAt: new Date('2026-09-01T12:00:00Z'), filedByName: 'Test Admin' },
      ],
    }), 'admin')
    expect(screen.getByRole('link', { name: /chest-ap\.jpg/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /attach image/i })).not.toBeInTheDocument()
  })

  it('renders no strip for an order with an empty attachments array', () => {
    renderWorklist(makeOrder({ status: 'ordered', attachments: [] }), 'admin')
    expect(screen.queryAllByRole('link')).toEqual([])
  })
})
