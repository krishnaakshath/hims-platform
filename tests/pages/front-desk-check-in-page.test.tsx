import { describe, it, expect, vi, afterEach } from 'vitest'
import { render as rtlRender, screen, cleanup, fireEvent, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { ToastProvider } from '@/components/ui/toast'

// Wave C quick path: /front-desk/check-in?patient=<chart id> opens the
// check-in modal with that patient preselected (from the patient page/list).
const state = vi.hoisted(() => ({ role: 'frontdesk' as string, getPickedPatient: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) }, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: 'Test WC', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
// WS6 T9 (spec D6): check-in offers only doctors of clinical departments, by department. The
// pathologist (diagnostic department) is an active provider but never a clinical doctor.
vi.mock('@/lib/queries/providers', () => ({
  listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. Meera Iyer' }, { id: 2, name: 'Dr. Kavya Shetty' }, { id: 9, name: 'Dr. Path Logist' }]),
  listClinicalDoctors: vi.fn(async () => [
    { id: 1, name: 'Dr. Meera Iyer', departmentId: 10, departmentName: 'General Medicine', opdRoom: '4' },
    { id: 2, name: 'Dr. Kavya Shetty', departmentId: 12, departmentName: 'Paediatrics', opdRoom: null },
  ]),
}))
vi.mock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
vi.mock('@/lib/queries/search', () => ({ getPickedPatient: state.getPickedPatient }))

import CheckInPage from '@/app/(dashboard)/front-desk/check-in/page'

const render = (ui: ReactElement) => rtlRender(<ToastProvider>{ui}</ToastProvider>)

afterEach(() => { cleanup(); state.role = 'frontdesk'; state.getPickedPatient.mockReset() })

describe('/front-desk/check-in quick path', () => {
  it('opens the check-in modal with the ?patient= patient preselected', async () => {
    state.getPickedPatient.mockResolvedValue({ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' })
    render(await CheckInPage({ searchParams: Promise.resolve({ patient: 'RD-0001' }) }))
    expect(state.getPickedPatient).toHaveBeenCalledWith('RD-0001')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
  })

  it('opens nothing without ?patient=, or for an unknown/malformed id', async () => {
    render(await CheckInPage({ searchParams: Promise.resolve({}) }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    cleanup()
    render(await CheckInPage({ searchParams: Promise.resolve({ patient: '<script>' }) }))
    expect(state.getPickedPatient).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    cleanup()
    state.getPickedPatient.mockResolvedValue(null)
    render(await CheckInPage({ searchParams: Promise.resolve({ patient: 'RD-9999' }) }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('offers clinical departments only, and a department lists only its doctors (no pathologist)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    state.getPickedPatient.mockResolvedValue({ id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' })
    render(await CheckInPage({ searchParams: Promise.resolve({ patient: 'RD-0001' }) }))
    const department = screen.getByLabelText(/^department$/i)
    expect(within(department).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a department…', 'General Medicine', 'Paediatrics'])
    fireEvent.change(department, { target: { value: '10' } })
    const doctors = within(screen.getByLabelText(/assign to doctor/i)).getAllByRole('option').map((o) => o.textContent)
    expect(doctors).toEqual(['Assign to doctor…', 'Dr. Meera Iyer'])
    expect(screen.queryByText(/Path Logist/)).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  it('redirects a role that cannot check in before any query', async () => {
    state.role = 'pi'
    await expect(CheckInPage({ searchParams: Promise.resolve({ patient: 'RD-0001' }) })).rejects.toThrow('NEXT_REDIRECT:/')
    expect(state.getPickedPatient).not.toHaveBeenCalled()
  })
})
