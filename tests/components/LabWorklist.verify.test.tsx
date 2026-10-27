// WS4 T11: Verify on the worklist explains itself when the viewer may not verify (spec 3.4).
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { WorklistOrder } from '@/components/LabWorklist'
import { LabWorklist } from '@/components/LabWorklist'
import type { Role } from '@/lib/auth'
import { VERIFY_DENIAL_MESSAGE } from '@/lib/labs/verification'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const LAB = 7
const GEN_MED = 3
const TECH_USER = 42
const PATHOLOGIST_USER = 41

function resulted(overrides: Partial<WorklistOrder> = {}): WorklistOrder {
  return {
    id: 1, status: 'resulted', orderedAt: new Date('2099-05-01T04:30:00Z'), collectedAt: new Date('2099-05-01T05:00:00Z'),
    receivedAt: new Date('2099-05-01T06:00:00Z'), verifiedAt: null, patientId: 'RD-1', patientName: 'Patient One', patientUhid: 'UH-1',
    testId: 1, testName: 'Complete blood count', testCode: 'CBC-DIFF', category: 'lab', attachments: [], orderedByProviderId: 1,
    orderedByProviderName: 'Dr. Ananya Rao', sampleId: 'L26100800429', requisitionId: 10, homeCollectionVisitId: null, visitDate: null,
    result: { value: 'See analytes', unit: null, flag: 'normal', resultedByName: 'Meenakshi Sundar', amendedAt: null },
    testDepartmentId: LAB, resultedByUserId: TECH_USER,
    ...overrides,
  }
}

const renderAs = (role: Role, verifierDepartmentId: number | null, userId: number | null, order = resulted()) =>
  render(<LabWorklist orders={[order]} labTests={[]} role={role} verifierDepartmentId={verifierDepartmentId} userId={userId} />)

describe('LabWorklist Verify availability', () => {
  it('a lab technician not linked to a provider sees a disabled Verify with the not_linked message', () => {
    renderAs('labs', null, TECH_USER)
    const verify = screen.getByRole('button', { name: 'Verify' })
    expect(verify).toBeDisabled()
    expect(screen.getByText(VERIFY_DENIAL_MESSAGE.not_linked)).toBeInTheDocument()
    expect(verify).toHaveAccessibleDescription(VERIFY_DENIAL_MESSAGE.not_linked)
  })

  it('the pathologist linked to Laboratory sees an enabled Verify and no reason', () => {
    renderAs('labs', LAB, PATHOLOGIST_USER)
    expect(screen.getByRole('button', { name: 'Verify' })).toBeEnabled()
    for (const m of Object.values(VERIFY_DENIAL_MESSAGE)) expect(screen.queryByText(m)).toBeNull()
  })

  it('a general physician sees Verify disabled: wrong department', () => {
    renderAs('pi', GEN_MED, 99)
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
    expect(screen.getByText(VERIFY_DENIAL_MESSAGE.wrong_department)).toBeInTheDocument()
  })

  it('the pathologist who entered the result sees Verify disabled: self verification', () => {
    renderAs('labs', LAB, TECH_USER)
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
    expect(screen.getByText(VERIFY_DENIAL_MESSAGE.self_verification)).toBeInTheDocument()
  })

  it('roles outside LAB_VERIFY_ROLES see no Verify at all', () => {
    renderAs('crc', LAB, 5)
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull()
    expect(screen.queryByText(VERIFY_DENIAL_MESSAGE.not_linked)).toBeNull()
  })
})
