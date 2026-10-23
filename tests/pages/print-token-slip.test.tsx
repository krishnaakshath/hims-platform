import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { Role } from '@/lib/auth'
import { brand } from '@/lib/brand'

class NotFound extends Error {}
class Redirect extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => { throw new NotFound() },
  redirect: (to: string) => { throw new Redirect(to) },
}))
const state = vi.hoisted(() => ({ role: 'frontdesk' as string, logAudit: vi.fn(async () => undefined), getTokenSlip: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: 'Test WC', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: state.logAudit }))
vi.mock('@/lib/queries/print-slips', () => ({ getTokenSlip: state.getTokenSlip }))

import TokenSlipPage from '@/app/print/token/[encounterId]/page'

const SLIP = {
  encounterId: 55, opdToken: 17, encounterType: 'opd', encounterDate: '2026-10-08', checkedInAt: new Date('2026-10-08T04:00:00Z'),
  patient: { id: 'RD-0042', name: 'Asha Rao', uhid: 'UH00000042' },
  doctorName: 'Dr. Meera Iyer', departmentName: 'General Medicine', room: null,
  roomLabel: null, waitingAhead: 0, estimatedWaitMinutes: 0,
}

afterEach(() => { cleanup(); state.role = 'frontdesk'; state.logAudit.mockClear(); state.getTokenSlip.mockReset() })

const run = (encounterId: string) => TokenSlipPage({ params: Promise.resolve({ encounterId }) })

describe('/print/token/[encounterId]', () => {
  it('prints token, name, UHID, doctor, department, IST time and the brand', async () => {
    state.getTokenSlip.mockResolvedValue(SLIP)
    render(await run('55'))
    expect(screen.getByText('17')).toBeInTheDocument()
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText(/UH00000042/)).toBeInTheDocument()
    expect(screen.getByText(/Dr\. Meera Iyer/)).toBeInTheDocument()
    expect(screen.getByText(/General Medicine/)).toBeInTheDocument()
    expect(screen.getByText('8 Oct 2026, 9:30 am')).toBeInTheDocument()
    expect(screen.getByText(brand.legalName)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /print/i })).toBeInTheDocument()
    expect(state.logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }), 'printed OPD token slip', 'RD-0042', 'encounter=55')
  })

  // WS6 T9: the doctor's room and the wait, for the patient to read in the lobby.
  it('shows the doctor, the OPD room and the estimated wait', async () => {
    state.getTokenSlip.mockResolvedValue({ ...SLIP, roomLabel: '4', waitingAhead: 3, estimatedWaitMinutes: 30 })
    render(await run('55'))
    expect(screen.getByText(/Dr\. Meera Iyer/)).toBeInTheDocument()
    expect(screen.getByText('Room 4')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('About 30 minutes')).toBeInTheDocument()
  })

  it('says the patient is next when nobody is ahead, and leaves out an unknown room and wait', async () => {
    state.getTokenSlip.mockResolvedValue(SLIP)
    render(await run('55'))
    expect(screen.getByText(/you are next/i)).toBeInTheDocument()
    expect(screen.queryByText(/^Room /)).not.toBeInTheDocument()
    cleanup()
    state.getTokenSlip.mockResolvedValue({ ...SLIP, encounterType: 'ipd', estimatedWaitMinutes: null })
    render(await run('55'))
    expect(screen.queryByText(/about .* minutes|you are next/i)).not.toBeInTheDocument()
  })

  it('says when no UHID has been issued and still shows the chart id', async () => {
    state.getTokenSlip.mockResolvedValue({ ...SLIP, patient: { ...SLIP.patient, uhid: null } })
    render(await run('55'))
    expect(screen.getByText(/UHID not issued/i)).toBeInTheDocument()
    expect(screen.getByText(/RD-0042/)).toBeInTheDocument()
  })

  it('shows the bed for an inpatient check-in', async () => {
    state.getTokenSlip.mockResolvedValue({ ...SLIP, encounterType: 'ipd', room: { ward: 'Ward A', roomNumber: '101', bedNumber: 'B' } })
    render(await run('55'))
    expect(screen.getByText(/Ward A.*101.*B/)).toBeInTheDocument()
  })

  it.each(['abc', '0', '-1', '12345678901'])('404s a malformed id %s before any query', async (id) => {
    await expect(run(id)).rejects.toBeInstanceOf(NotFound)
    expect(state.getTokenSlip).not.toHaveBeenCalled()
  })

  it('404s an unknown encounter without auditing', async () => {
    state.getTokenSlip.mockResolvedValue(null)
    await expect(run('9')).rejects.toBeInstanceOf(NotFound)
    expect(state.logAudit).not.toHaveBeenCalled()
  })

  it.each(['pi', 'pharmacy', 'billing', 'labs'] as Role[])('redirects %s home before any query', async (role) => {
    state.role = role
    await expect(run('55')).rejects.toBeInstanceOf(Redirect)
    expect(state.getTokenSlip).not.toHaveBeenCalled()
  })
})
