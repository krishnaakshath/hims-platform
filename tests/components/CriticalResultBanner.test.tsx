// WS4 T12 (spec 3.5 item 25): the critical banner -- summary + patient, the call-log line, and the
// action the viewer may take (Log call while open, Acknowledge only where allowed).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const h = vi.hoisted(() => ({ refresh: vi.fn(), sendJson: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }) }))
vi.mock('@/lib/client-fetch', () => ({ sendJson: h.sendJson }))

import { CriticalResultBanner, criticalCallLine } from '@/components/labs/CriticalResultBanner'
import type { CriticalAlertRow } from '@/lib/queries/lab-critical'

afterEach(() => { cleanup(); h.refresh.mockReset(); h.sendJson.mockReset() })

const OPEN: CriticalAlertRow = {
  orderId: 41, patientId: 'RD-0041', patientName: 'Ravi K', uhid: 'UH000041', testName: 'Complete Blood Count', summary: 'Platelets 38 ×10³/µL',
  status: 'open', raisedAt: '2026-10-24T04:30:00.000Z', notifiedAt: null, notifiedByName: null, notifiedToName: null, notifyChannel: null, readBack: null,
  acknowledgedAt: null, acknowledgedByName: null, orderedByProviderId: 3,
}
const NOTIFIED: CriticalAlertRow = {
  ...OPEN, orderId: 42, status: 'notified', notifiedAt: '2026-10-24T05:12:00.000Z', notifiedByName: 'Meenakshi Sundar', notifiedToName: 'Dr Rao', notifyChannel: 'phone', readBack: true,
}

describe('CriticalResultBanner', () => {
  it('renders nothing without alerts', () => {
    const { container } = render(<CriticalResultBanner alerts={[]} canNotify canAcknowledge={() => true} />)
    expect(container.innerHTML).toBe('')
  })

  it('shows the summary, the patient with UHID and the call log line', () => {
    render(<CriticalResultBanner alerts={[OPEN, NOTIFIED]} canNotify={false} canAcknowledge={() => false} />)
    expect(screen.getAllByText('CRITICAL · Platelets 38 ×10³/µL · Ravi K (UH000041)')).toHaveLength(2)
    expect(screen.getByText(/Notified Dr Rao at 10:42 am by Meenakshi Sundar \(phone, read back\)/)).toBeTruthy()
    expect(screen.getByText(/Call not yet logged/)).toBeTruthy()
    expect(screen.getByText('2 critical results not yet acknowledged')).toBeTruthy()
  })

  it('for the lab: Log call on the open alert only, never Acknowledge', () => {
    render(<CriticalResultBanner alerts={[OPEN, NOTIFIED]} canNotify canAcknowledge={() => false} />)
    expect(screen.getAllByRole('button', { name: /log the call/i })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull()
  })

  it('for the owning doctor: Acknowledge where allowed, posting to the critical acknowledge route', async () => {
    h.sendJson.mockResolvedValue({ ok: true, data: { ok: true } })
    render(<CriticalResultBanner alerts={[OPEN, NOTIFIED]} canNotify={false} canAcknowledge={(a) => a.orderId === 42} />)
    const buttons = screen.getAllByRole('button', { name: 'Acknowledge critical Complete Blood Count' })
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0])
    await waitFor(() => expect(h.refresh).toHaveBeenCalled())
    expect(h.sendJson).toHaveBeenCalledWith('/api/lab-orders/42/critical/acknowledge', 'POST', {})
  })

  it('the call form requires read-back for a phone call and shows a server refusal', async () => {
    h.sendJson.mockResolvedValue({ ok: false, error: 'The call for this critical result has already been logged.' })
    render(<CriticalResultBanner alerts={[OPEN]} canNotify canAcknowledge={() => false} />)
    fireEvent.click(screen.getByRole('button', { name: /log the call/i }))
    fireEvent.change(screen.getByLabelText(/called/i), { target: { value: 'Dr Rao' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save call' }))
    expect(screen.getByText(/must be read back/)).toBeTruthy()
    expect(h.sendJson).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText(/value read back/i))
    fireEvent.click(screen.getByRole('button', { name: 'Save call' }))
    await waitFor(() => expect(screen.getByText(/already been logged/)).toBeTruthy())
    expect(h.sendJson).toHaveBeenCalledWith('/api/lab-orders/41/critical/notify', 'POST', { notifiedToName: 'Dr Rao', channel: 'phone', readBack: true })
    expect(h.refresh).not.toHaveBeenCalled()
  })

  it('criticalCallLine is null until the call is logged', () => {
    expect(criticalCallLine(OPEN)).toBeNull()
    expect(criticalCallLine({ ...NOTIFIED, notifyChannel: 'in_person', readBack: false })).toBe('Notified Dr Rao at 10:42 am by Meenakshi Sundar (in person)')
  })
})
