// Final audit: the worklist's "Print label" link opens /lab-labels, which admits only
// LAB_LABEL_ROLES. crc reaches the worklist but not the label sheet, so the link must not show
// for crc (the HTTP role/route matrix found it as a dead link: crc -> redirected home).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { WorklistOrder } from '@/components/LabWorklist'
import { LabWorklist } from '@/components/LabWorklist'
import { LAB_LABEL_ROLES, LAB_WORKLIST_ROLES } from '@/lib/role-policy'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
afterEach(cleanup)

const collected: WorklistOrder = {
  id: 7, status: 'collected', orderedAt: new Date('2099-05-01T04:30:00Z'), collectedAt: new Date('2099-05-01T05:00:00Z'),
  receivedAt: null, verifiedAt: null, patientId: 'RD-7', patientName: 'Patient 7', patientUhid: 'UH-7', testId: 1,
  testName: 'Glucose, fasting', testCode: 'GLU', category: 'lab', attachments: [], orderedByProviderId: 1,
  orderedByProviderName: 'Dr. Test', sampleId: 'L26100800438', requisitionId: 10, homeCollectionVisitId: null, visitDate: null, result: null,
}

describe('LabWorklist print-label link', () => {
  for (const role of LAB_WORKLIST_ROLES) {
    const may = LAB_LABEL_ROLES.includes(role)
    it(`${may ? 'shows' : 'hides'} Print label for ${role}`, () => {
      render(<LabWorklist orders={[collected]} labTests={[]} role={role} stage="in-transit" />)
      expect(screen.queryAllByRole('link', { name: 'Print label' }).length > 0).toBe(may)
    })
  }
})
