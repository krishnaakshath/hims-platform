import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { FollowUpPlanModal } from '@/components/follow-ups/FollowUpPlanModal'
import { FU } from './fixtures'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const BASE = {
  patientId: 'RD-0001', providers: [{ id: 7, name: 'Dr. K' }], departments: [{ id: 2, name: 'Cardiology' }, { id: 3, name: 'Neurology' }],
  encounters: [], isPi: true, todayIso: '2026-10-20', onClose: vi.fn(),
}

describe('FollowUpPlanModal', () => {
  it('ties field errors to their inputs with aria-invalid, aria-describedby and role=alert', async () => {
    render(<FollowUpPlanModal {...BASE} mode="create" />)
    fireEvent.click(screen.getByRole('button', { name: /save follow-up/i }))
    const reason = screen.getByLabelText(/^reason/i)
    expect(reason).toHaveAttribute('aria-invalid', 'true')
    const descId = reason.getAttribute('aria-describedby')!
    const msg = document.getElementById(descId)!
    expect(msg).toHaveAttribute('role', 'alert')
    expect(msg.textContent).toMatch(/reason/i)
  })

  it('labels the notes field with exactly the roles that can read it', () => {
    render(<FollowUpPlanModal {...BASE} mode="create" />)
    expect(screen.getByLabelText(/clinical plan notes \(visible to doctors, admin and CRC\)/i)).toBeInTheDocument()
  })

  it('edit mode keeps the existing department when saving another change', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ order: null, bookingOutsideWindow: false }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<FollowUpPlanModal {...BASE} mode="edit" initial={FU} />)
    const dept = screen.getByLabelText(/^department/i) as HTMLSelectElement
    expect(dept.value).toBe('2')
    expect([...dept.options].map((o) => o.value)).not.toContain('')
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'BP and labs' } })
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ reason: 'BP and labs' })
  })

  it('keeps an inactive current department selectable so it is not nulled', () => {
    render(<FollowUpPlanModal {...BASE} departments={[{ id: 3, name: 'Neurology' }]} mode="edit" initial={FU} />)
    expect((screen.getByLabelText(/^department/i) as HTMLSelectElement).value).toBe('2')
  })
})
