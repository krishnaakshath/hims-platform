// WS1 T3: the consultation workspace page /encounters/[id]. Queries are mocked; the page is a
// server component rendered once, then its client tabs are exercised.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

const h = vi.hoisted(() => ({
  role: 'pi',
  view: null as unknown,
  redirect: vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) }),
  getWorkspace: vi.fn(),
  push: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: h.redirect,
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: h.role, name: 'Dr. A Rao', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/encounter-workspace', () => ({
  getWorkspace: h.getWorkspace,
  patientDiagnosisCodes: vi.fn(async () => []),
}))
vi.mock('@/lib/queries/medications', () => ({ listMedicationsWithInventory: vi.fn(async () => []) }))
vi.mock('@/lib/queries/providers', () => ({ listAllProviders: vi.fn(async () => []) }))
vi.mock('@/lib/queries/lab-tests', () => ({ listLabTests: vi.fn(async () => []) }))
vi.mock('@/lib/provider-identity', () => ({ resolveSessionProvider: vi.fn(async () => ({ id: 3, name: 'Dr. A Rao' })) }))

import EncounterWorkspacePage from '@/app/(dashboard)/encounters/[id]/page'

function makeView(over: Record<string, unknown> = {}) {
  return {
    encounter: { id: 41, status: 'checked_in', encounterType: 'opd', visitType: 'new', encounterDate: '2026-10-23', opdToken: 7, departmentName: 'General Medicine', providerId: 3, providerName: 'Dr. A Rao', checkedInAt: new Date('2026-10-23T04:00:00Z') },
    patient: {
      id: 'RD-0042', uhid: 'UH-2026-000042', name: 'Meena Iyer', ageYears: 46, sex: 'female', phone: '9876543210', payerName: null,
      allergyStatus: 'unknown', allergies: [], alerts: ['allergy_status_unknown'],
    },
    vitals: [], consult: null, history: [],
    canWrite: true, canRecordVitals: true,
    ...over,
  }
}

const props = (id = '41') => ({ params: Promise.resolve({ id }) })

describe('/encounters/[id] workspace page', () => {
  beforeEach(() => {
    h.role = 'pi'
    h.redirect.mockClear()
    h.push.mockClear()
    h.getWorkspace.mockReset()
    h.getWorkspace.mockImplementation(async () => makeView())
  })

  it('renders the patient strip with the UHID (never the chart id), the unknown-allergy alert and six tabs', async () => {
    render(await EncounterWorkspacePage(props()))
    expect(screen.getByText('Meena Iyer')).toBeInTheDocument()
    expect(screen.getByText('UH-2026-000042')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('RD-0042')
    expect(screen.getByText('Allergy status not recorded')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent)
    expect(tabs).toEqual(['Vitals', 'History', 'Diagnosis', 'Rx', 'Orders', 'Notes'])
    expect(h.getWorkspace).toHaveBeenCalledWith(41, expect.objectContaining({ role: 'pi' }))
  })

  it('shows allergy chips for recorded allergies and no unknown-status alert', async () => {
    h.getWorkspace.mockImplementation(async () => makeView({
      patient: { ...makeView().patient, allergyStatus: 'recorded', alerts: ['currently_admitted'], allergies: [
        { id: 1, allergen: 'Penicillin', reaction: 'rash', severity: 'severe' },
        { id: 2, allergen: 'Peanuts', reaction: null, severity: 'mild' },
      ] },
    }))
    render(await EncounterWorkspacePage(props()))
    const chips = screen.getByRole('list', { name: /allergies/i })
    expect(within(chips).getByText(/Penicillin/)).toBeInTheDocument()
    expect(within(chips).getByText(/Peanuts/)).toBeInTheDocument()
    expect(screen.queryByText('Allergy status not recorded')).toBeNull()
    expect(screen.getByText('Currently admitted')).toBeInTheDocument()
  })

  it('a checked-in visit offers "Start consultation" and the GET render does not start it', async () => {
    render(await EncounterWorkspacePage(props()))
    expect(screen.getByRole('button', { name: /start consultation/i })).toBeInTheDocument()
    expect(h.push).not.toHaveBeenCalled()
  })

  it('switches tabs: the Rx tab offers the existing prescription dialog', async () => {
    render(await EncounterWorkspacePage(props()))
    fireEvent.click(screen.getByRole('tab', { name: 'Rx' }))
    expect(screen.getByRole('tab', { name: 'Rx' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: /add prescription/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(screen.getByRole('button', { name: /order test/i })).toBeInTheDocument()
  })

  it('read-only viewer (another doctor) gets no write controls', async () => {
    h.getWorkspace.mockImplementation(async () => makeView({ canWrite: false, canRecordVitals: false }))
    render(await EncounterWorkspacePage(props()))
    expect(screen.queryByRole('button', { name: /start consultation/i })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Rx' }))
    expect(screen.queryByRole('button', { name: /add prescription/i })).toBeNull()
  })

  it('redirects labs to its worklist and frontdesk home, before any query', async () => {
    h.role = 'labs'
    await expect(EncounterWorkspacePage(props())).rejects.toThrow('NEXT_REDIRECT /labs')
    h.role = 'frontdesk'
    await expect(EncounterWorkspacePage(props())).rejects.toThrow('NEXT_REDIRECT /')
    expect(h.getWorkspace).not.toHaveBeenCalled()
  })

  it('404s a bad id or a missing encounter', async () => {
    await expect(EncounterWorkspacePage(props('abc'))).rejects.toThrow('NEXT_NOT_FOUND')
    h.getWorkspace.mockImplementation(async () => null)
    await expect(EncounterWorkspacePage(props('999'))).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
