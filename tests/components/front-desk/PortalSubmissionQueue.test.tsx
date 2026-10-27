// WS7 T9 (spec D15): the reviewer's queue. A policy needs an insurer before Approve; a reject needs
// a reason (5 to 300 characters) that the patient will see; refusals show the server's message.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { ToastProvider } from '@/components/ui/toast'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/lib/client-fetch', () => ({ sendJson: vi.fn() }))

import { sendJson } from '@/lib/client-fetch'
import { PortalSubmissionQueue, type PortalSubmissionQueueRow } from '@/components/front-desk/PortalSubmissionQueue'

// The dashboard layout wraps every page in ToastProvider; so do these renders.
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider })

const POLICY: PortalSubmissionQueueRow = {
  id: 5, kind: 'policy', patientName: 'Asha Rao', uhid: 'UHID-26-000123', submittedAt: '2026-10-20T05:00:00.000Z',
  details: [{ label: 'Policy number', value: 'P-123' }], hasCard: true, cardHref: '/api/documents/9/download', policyHref: '/rcm/policies?patientId=RD-0001',
}
const ABHA: PortalSubmissionQueueRow = { ...POLICY, id: 6, kind: 'abha', details: [{ label: 'ABHA number', value: '91-1234-5678-9012' }], hasCard: false, cardHref: null }

beforeEach(() => { vi.mocked(sendJson).mockReset(); refresh.mockReset() })

describe('PortalSubmissionQueue', () => {
  it('says so when nothing is waiting', () => {
    render(<PortalSubmissionQueue rows={[]} insurers={[]} tpas={[]} />)
    expect(screen.getByText(/No portal submissions are waiting/)).toBeInTheDocument()
  })

  it('a policy is approved only with an insurer, and posts the payer ids', async () => {
    vi.mocked(sendJson).mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true } })
    render(<PortalSubmissionQueue rows={[POLICY]} insurers={[{ payerId: 3, name: 'Star Health' }]} tpas={[{ payerId: 4, name: 'Medi Assist' }]} />)
    expect(screen.getByText(/UHID UHID-26-000123/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open card' })).toHaveAttribute('href', '/api/documents/9/download')
    const approve = screen.getByRole('button', { name: 'Approve' })
    expect(approve).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Insurer'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('TPA'), { target: { value: '4' } })
    fireEvent.click(approve)
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(sendJson).toHaveBeenCalledWith('/api/front-desk/portal-submissions/5/decision', 'POST', { decision: 'approve', insurerPayerId: 3, tpaPayerId: 4 })
    // WS7 T16: the next step after approving a policy is the patient's policies.
    expect(screen.getByText('Policy added')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open policy' })).toHaveAttribute('href', '/rcm/policies?patientId=RD-0001')
  })

  it('an ABHA is approved as is; a 409 shows the message', async () => {
    vi.mocked(sendJson).mockResolvedValueOnce({ ok: false, status: 409, error: 'This ABHA number is already registered to another patient' })
    render(<PortalSubmissionQueue rows={[ABHA]} insurers={[]} tpas={[]} />)
    expect(screen.getByText('None attached')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already registered to another patient')
    expect(sendJson).toHaveBeenCalledWith('/api/front-desk/portal-submissions/6/decision', 'POST', { decision: 'approve' })
    expect(refresh).not.toHaveBeenCalled()
  })

  it('reject needs a reason of at least 5 characters', async () => {
    vi.mocked(sendJson).mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true } })
    render(<PortalSubmissionQueue rows={[POLICY]} insurers={[]} tpas={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    const send = screen.getByRole('button', { name: 'Reject with reason' })
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'no' } })
    expect(send).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '  Card is not readable  ' } })
    fireEvent.click(send)
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(sendJson).toHaveBeenCalledWith('/api/front-desk/portal-submissions/5/decision', 'POST', { decision: 'reject', reason: 'Card is not readable' })
  })
})
