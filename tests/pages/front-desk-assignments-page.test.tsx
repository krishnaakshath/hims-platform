import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

// WS6 T9: the assignments log names the patient ("Name · UHID"), never the chart id.
const state = vi.hoisted(() => ({ listAllAssignments: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) }, useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'frontdesk', name: 'Test WC', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/doctor-assignments', () => ({ listAllAssignments: state.listAllAssignments }))
vi.mock('@/lib/queries/providers', () => ({ listAllProviders: vi.fn(async () => [{ id: 3, name: 'Dr. Meera Iyer' }]) }))

import AssignmentsPage from '@/app/(dashboard)/front-desk/assignments/page'

const ROW = {
  id: 1, patientId: 'RD-0040', providerId: 3, visitType: 'outpatient', urgency: 'routine', reason: 'Fever', status: 'pending',
  roomId: null, assignedByName: 'Test WC', appointmentId: null, declineReason: null, queueTicketNumber: 12,
  declineAcknowledgedAt: null, declineAcknowledgedByName: null, patientNotifiedAt: null, createdAt: new Date('2026-10-23T04:00:00Z'),
  patientName: 'Sarojamma K', uhid: 'UH00000040',
}

afterEach(() => { cleanup(); state.listAllAssignments.mockReset() })

describe('/front-desk/assignments', () => {
  it('shows the patient as "Name · UHID" and never the chart id', async () => {
    state.listAllAssignments.mockResolvedValue([ROW])
    const { container } = render(await AssignmentsPage())
    const table = screen.getByRole('table')
    expect(within(table).getByText('Sarojamma K · UH00000040')).toBeInTheDocument()
    expect(within(table).getByText('Dr. Meera Iyer')).toBeInTheDocument()
    expect(container.textContent).not.toContain('RD-0040')
  })

  it('shows the name alone when no UHID has been issued', async () => {
    state.listAllAssignments.mockResolvedValue([{ ...ROW, uhid: null }])
    const { container } = render(await AssignmentsPage())
    expect(screen.getByText('Sarojamma K')).toBeInTheDocument()
    expect(container.textContent).not.toContain('RD-0040')
  })

  it('renders the empty state when there are no assignments', async () => {
    state.listAllAssignments.mockResolvedValue([])
    render(await AssignmentsPage())
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(screen.getByText('No assignments yet')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /check in a patient/i })).toHaveAttribute('href', '/front-desk/check-in')
  })
})
