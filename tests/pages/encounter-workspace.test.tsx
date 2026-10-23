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
  chargeLines: vi.fn(async (): Promise<unknown[]> => []),
}))

vi.mock('next/navigation', () => ({
  redirect: h.redirect,
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
}))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: h.role, name: 'Dr. A Rao', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/encounter-workspace', () => ({ getWorkspace: h.getWorkspace }))
vi.mock('@/lib/queries/providers', () => ({ listAllProviders: vi.fn(async () => []) }))
vi.mock('@/lib/queries/lab-tests', () => ({ listLabTests: vi.fn(async () => []) }))
// WS1 T4
vi.mock('@/lib/queries/encounter-diagnoses', () => ({ listEncounterDiagnoses: vi.fn(async () => []), listProblemList: vi.fn(async () => []) }))
vi.mock('@/lib/queries/referrals', () => ({ listEncounterReferrals: vi.fn(async () => []) }))
vi.mock('@/lib/queries/departments', () => ({ listDepartments: vi.fn(async () => []) }))
// WS1 T5 / WS2 T14: the visit's notes and its charge lines (header chip).
vi.mock('@/lib/queries/encounter-notes', () => ({ listNotesForEncounter: vi.fn(async () => []) }))
vi.mock('@/lib/queries/charge-capture', () => ({ listChargeLinesForContext: h.chargeLines }))

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
    h.chargeLines.mockReset()
    h.chargeLines.mockImplementation(async () => [])
    // The real panels load their lists on mount (orders, procedures).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ orders: [], billTo: 'self', procedures: [], options: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
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

  // WS2 T14: every tab mounts its real panel (no launcher dialogs).
  it('all six tabs mount their real panels: Rx builder, lab orders and procedures with the visit, visit notes', async () => {
    render(await EncounterWorkspacePage(props()))
    const panel = (key: string) => document.getElementById(`ws-panel-${key}`)!
    expect(within(panel('vitals')).getByRole('heading', { name: 'Recorded this visit' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(within(panel('history')).getByRole('heading', { name: 'Previous visits' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Diagnosis' }))
    expect(within(panel('diagnosis')).getByRole('heading', { name: 'Diagnoses this visit' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Rx' }))
    expect(screen.getByRole('tab', { name: 'Rx' })).toHaveAttribute('aria-selected', 'true')
    expect(within(panel('rx')).getByRole('combobox', { name: 'Drug search' })).toBeInTheDocument()
    expect(within(panel('rx')).getByRole('button', { name: 'Save prescription' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add prescription/i })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(within(panel('orders')).getByRole('heading', { name: 'Order tests' })).toBeInTheDocument()
    expect(within(panel('orders')).getByRole('heading', { name: 'Order a procedure' })).toBeInTheDocument()
    expect(await within(panel('orders')).findByText('No tests ordered from this visit.')).toBeInTheDocument()
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]))
    expect(urls).toContain('/api/patients/RD-0042/lab-orders?encounterId=41')
    expect(urls).toContain('/api/encounters/41/procedures')
    expect(screen.queryByRole('button', { name: 'Order test' })).toBeNull() // the old launcher
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }))
    expect(within(panel('notes')).getByRole('button', { name: 'New Note' })).toBeInTheDocument()
  })

  it('header chip: the visit charges (live lines, GST-inclusive estimate) and their count', async () => {
    h.chargeLines.mockImplementation(async () => [
      { id: 1, status: 'captured', taxablePaise: 60000, gstRateBp: 0 },
      { id: 2, status: 'invoiced', taxablePaise: 4680, gstRateBp: 1200 },
      { id: 3, status: 'void', taxablePaise: 99999, gstRateBp: 0 },
    ])
    render(await EncounterWorkspacePage(props()))
    expect(h.chargeLines).toHaveBeenCalledWith({ encounterId: 41 })
    // 600.00 + 46.80 + 5.62 GST (2.81 CGST + 2.81 SGST) = 652.42; the void line is left out.
    expect(screen.getByText('Visit charges ₹652.42 (2 lines)')).toBeInTheDocument()
  })

  it('header chip: no lines yet reads "Visit charges ₹0.00 (0 lines)"', async () => {
    render(await EncounterWorkspacePage(props()))
    expect(screen.getByText('Visit charges ₹0.00 (0 lines)')).toBeInTheDocument()
  })

  it('read-only viewer (another doctor) gets no write controls', async () => {
    h.getWorkspace.mockImplementation(async () => makeView({ canWrite: false, canRecordVitals: false }))
    render(await EncounterWorkspacePage(props()))
    expect(screen.queryByRole('button', { name: /start consultation/i })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Rx' }))
    expect(screen.queryByRole('button', { name: 'Save prescription' })).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Orders' }))
    expect(screen.queryByRole('heading', { name: 'Order tests' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Order a procedure' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Orders from this visit' })).toBeInTheDocument()
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
