import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

// Wave C quick path: /front-desk/check-in?patient=<chart id> opens the
// check-in modal with that patient preselected (from the patient page/list).
const state = vi.hoisted(() => ({ role: 'frontdesk' as string, getPickedPatient: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) }, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: 'Test WC', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 1, name: 'Dr. Meera Iyer' }]) }))
vi.mock('@/lib/queries/rooms', () => ({ listAvailableRooms: vi.fn(async () => []) }))
vi.mock('@/lib/queries/search', () => ({ getPickedPatient: state.getPickedPatient }))

import CheckInPage from '@/app/(dashboard)/front-desk/check-in/page'

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

  it('redirects a role that cannot check in before any query', async () => {
    state.role = 'pi'
    await expect(CheckInPage({ searchParams: Promise.resolve({ patient: 'RD-0001' }) })).rejects.toThrow('NEXT_REDIRECT:/')
    expect(state.getPickedPatient).not.toHaveBeenCalled()
  })
})
