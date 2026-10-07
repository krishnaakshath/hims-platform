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
const state = vi.hoisted(() => ({ role: 'frontdesk' as string, logAudit: vi.fn(async () => undefined), getRegistrationSlip: vi.fn() }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: 'Test WC', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: state.logAudit }))
vi.mock('@/lib/queries/print-slips', () => ({ getRegistrationSlip: state.getRegistrationSlip }))

import RegistrationSlipPage from '@/app/print/registration/[anonId]/page'

// 2026-10-07T20:00Z is 8 Oct 2026 01:30 IST: the slip must show the IST date.
const SLIP = { id: 'RD-0042', name: 'Asha Rao', uhid: 'UH00000042', registeredAt: new Date('2026-10-07T20:00:00Z') }

afterEach(() => { cleanup(); state.role = 'frontdesk'; state.logAudit.mockClear(); state.getRegistrationSlip.mockReset() })

const run = (anonId: string) => RegistrationSlipPage({ params: Promise.resolve({ anonId }) })

describe('/print/registration/[anonId]', () => {
  it('prints name, UHID, IST registration date and the brand -- and nothing else identifying', async () => {
    state.getRegistrationSlip.mockResolvedValue(SLIP)
    const { container } = render(await run('RD-0042'))
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.getByText('UH00000042')).toBeInTheDocument()
    expect(screen.getByText('8 Oct 2026')).toBeInTheDocument()
    expect(screen.getByText(brand.legalName)).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/aadhaar|abha|date of birth|dob/i)
    expect(state.logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'frontdesk' }), 'printed registration slip', 'RD-0042')
  })

  it('says when no UHID has been issued', async () => {
    state.getRegistrationSlip.mockResolvedValue({ ...SLIP, uhid: null })
    render(await run('RD-0042'))
    expect(screen.getByText(/UHID not issued/i)).toBeInTheDocument()
    expect(screen.getByText(/RD-0042/)).toBeInTheDocument()
  })

  it.each(['x'.repeat(41), 'RD 0001', '../etc'])('404s a malformed id before any query', async (id) => {
    await expect(run(id)).rejects.toBeInstanceOf(NotFound)
    expect(state.getRegistrationSlip).not.toHaveBeenCalled()
  })

  it('404s an unknown patient without auditing', async () => {
    state.getRegistrationSlip.mockResolvedValue(null)
    await expect(run('RD-9999')).rejects.toBeInstanceOf(NotFound)
    expect(state.logAudit).not.toHaveBeenCalled()
  })

  it.each(['crc', 'pi', 'pharmacy', 'billing', 'labs'] as Role[])('redirects %s home before any query', async (role) => {
    state.role = role
    await expect(run('RD-0042')).rejects.toBeInstanceOf(Redirect)
    expect(state.getRegistrationSlip).not.toHaveBeenCalled()
  })
})
