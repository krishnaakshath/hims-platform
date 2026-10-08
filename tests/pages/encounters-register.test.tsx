import { describe, it, expect, vi, afterEach } from 'vitest'

// Wave F P1-04: the OPD register page (/encounters).
class Redirect extends Error {}
const state = vi.hoisted(() => ({
  role: 'admin',
  redirect: vi.fn(),
  list: vi.fn(),
  logAudit: vi.fn(async () => undefined),
}))
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  redirect: (to: string) => { state.redirect(to); throw new Redirect(to) },
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: state.role, name: 'Test', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: state.logAudit }))
vi.mock('@/lib/queries/encounter-register', () => ({ listEncounterRegister: state.list }))
vi.mock('@/lib/queries/departments', () => ({ listDepartments: vi.fn(async () => [{ id: 3, name: 'General Medicine', code: 'GM', kind: 'clinical', isActive: true }]) }))
vi.mock('@/lib/queries/providers', () => ({ listActiveProviders: vi.fn(async () => [{ id: 12, name: 'Dr. Meera Iyer', isActive: true }]) }))

import EncountersPage from '@/app/(dashboard)/encounters/page'

const ROW = {
  id: 9, encounterDate: '2026-10-08', opdToken: 4, encounterType: 'opd', visitType: 'follow_up', status: 'in_consultation',
  checkedInAt: new Date('2026-10-08T03:45:00Z'), completedAt: null,
  patientId: 'RD-0042', patientName: 'Asha Rao', uhid: 'UH-000042', ageYears: 46, gender: 'female',
  departmentName: 'General Medicine', doctorName: 'Dr. Meera Iyer',
}
const RESULT = { rows: [ROW], total: 1, truncated: false, statusCounts: { checked_in: 0, in_consultation: 1, completed: 0, cancelled: 0 } }

function page(sp: Record<string, string> = {}) {
  return EncountersPage({ searchParams: Promise.resolve(sp) })
}

afterEach(() => {
  state.role = 'admin'
  state.redirect.mockClear()
  state.list.mockReset()
  state.logAudit.mockClear()
})

describe('/encounters (OPD register)', () => {
  it('renders the register with token, patient, UHID, age/sex, department, doctor, status and the IST check-in time', async () => {
    state.list.mockResolvedValue(RESULT)
    const { render, screen } = await import('@testing-library/react')
    render(await page({ from: '2026-10-08', to: '2026-10-08', department: '3' }))
    expect(screen.getByRole('heading', { name: /opd register/i })).toBeInTheDocument()
    expect(state.list).toHaveBeenCalledWith({ from: '2026-10-08', to: '2026-10-08', type: 'opd', status: null, departmentId: 3, providerId: null })
    const table = screen.getByRole('table', { name: /opd register/i })
    expect(table).toHaveTextContent('Asha Rao')
    expect(table).toHaveTextContent('UH-000042')
    expect(table).toHaveTextContent('46 y / Female')
    expect(table).toHaveTextContent('General Medicine')
    expect(table).toHaveTextContent('Dr. Meera Iyer')
    expect(table).toHaveTextContent('In consultation')
    expect(table).toHaveTextContent('Follow-up')
    expect(table).toHaveTextContent('9:15 am')
    expect(screen.getByRole('link', { name: 'Asha Rao' })).toHaveAttribute('href', '/patients/RD-0042')
    // The filter form works without JavaScript.
    expect(document.querySelector('form[method="get"]')).not.toBeNull()
  })

  it('admin and crc get the CSV export link carrying the same filters', async () => {
    for (const role of ['admin', 'crc']) {
      state.role = role
      state.list.mockResolvedValue(RESULT)
      const { render, screen, cleanup } = await import('@testing-library/react')
      render(await page({ from: '2026-10-01', to: '2026-10-08', status: 'completed' }))
      expect(screen.getByRole('link', { name: /export csv/i })).toHaveAttribute('href', '/api/encounters/register/export?from=2026-10-01&to=2026-10-08&type=opd&status=completed')
      cleanup()
    }
  })

  it.each(['pi', 'frontdesk'])('%s sees the register but no export link', async (role) => {
    state.role = role
    state.list.mockResolvedValue(RESULT)
    const { render, screen } = await import('@testing-library/react')
    render(await page())
    expect(screen.getByText('Asha Rao')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /export csv/i })).toBeNull()
  })

  it('an invalid filter shows the error and does not query', async () => {
    const { render, screen } = await import('@testing-library/react')
    render(await page({ from: '2026-10-08', to: '2026-10-01' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/after the "to" date/i)
    expect(state.list).not.toHaveBeenCalled()
  })

  it('says when the list is truncated', async () => {
    state.list.mockResolvedValue({ ...RESULT, total: 2500, truncated: true })
    const { render, screen } = await import('@testing-library/react')
    render(await page())
    expect(screen.getByText(/showing the first 1 of 2500/i)).toBeInTheDocument()
  })

  it.each(['pharmacy', 'billing', 'labs', 'coder', 'collector'])('a %s session is redirected home before any query', async (role) => {
    state.role = role
    await expect(page()).rejects.toThrow(Redirect)
    expect(state.redirect).toHaveBeenCalledWith('/')
    expect(state.list).not.toHaveBeenCalled()
  })
})
