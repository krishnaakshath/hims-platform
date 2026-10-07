import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import type { CodingWorkspace, WorkspaceDiagnosis, WorkspaceProcedure } from '@/lib/queries/coding-workspace'
import type { EncounterCodingStatus } from '@/lib/coding/status'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const dx = (o: Partial<WorkspaceDiagnosis> = {}): WorkspaceDiagnosis => ({
  id: 11, description: 'Type 2 diabetes', type: 'primary', codingStatus: 'coded', sequence: 1, proposedByName: null, codedByName: 'Asha Coder',
  codeId: 501, kind: 'icd10', code: 'E11.9', display: 'Type 2 diabetes mellitus without complications', version: '2026', isSample: false, ...o,
})
const proc = (o: Partial<WorkspaceProcedure> = {}): WorkspaceProcedure => ({
  id: 21, description: 'ECG', codingStatus: 'uncoded', performedOn: '2026-10-01', performedByName: 'Dr. K', serviceId: null, serviceName: null,
  sequence: null, proposedByName: null, codeId: null, kind: null, code: '', display: null, version: null, isSample: false, ...o,
})

function workspace(status: EncounterCodingStatus, o: Partial<CodingWorkspace> = {}): CodingWorkspace {
  return {
    patient: { id: 'P-1', name: 'Asha Rao', uhid: 'UH-0001', gender: 'female', ageYears: 54 },
    encounter: {
      id: 7, encounterType: 'opd', visitType: 'new', status: 'completed', encounterDate: '2026-10-01',
      completedAt: new Date('2026-10-01T06:00:00Z'), departmentName: 'Cardiology', providerId: 3, providerName: 'Dr. K', admissionId: null,
    },
    coding: {
      status, assignedToUserId: 5, assignedToName: 'Asha Coder', codedByName: null, codedAt: null,
      finalisedByName: status === 'finalised' ? 'Asha Coder' : null, finalisedAt: status === 'finalised' ? new Date('2026-10-03T06:00:00Z') : null, reopenCount: 0,
    },
    diagnoses: [
      dx(),
      dx({ id: 12, type: 'secondary', codingStatus: 'proposed', proposedByName: 'Dr. K', codedByName: null, codeId: 502, code: 'I10', display: 'Essential hypertension', description: 'Hypertension', isSample: true, version: 'SAMPLE-ICD10-0' }),
    ],
    procedures: [proc()],
    notes: [{
      id: 31, noteType: 'progress', authorName: 'Dr. K', signedAt: new Date('2026-10-01T05:00:00Z'),
      subjective: 'Thirsty for weeks <b>not bold</b>', objective: 'BP 150/90', assessment: 'Likely T2DM', plan: 'Start metformin',
    }],
    queries: [{
      id: 41, status: 'answered', question: 'Is the diabetes controlled?', addressedToProviderId: 3, addressedToName: 'Dr. K', raisedByName: 'Asha Coder',
      raisedAt: new Date('2026-10-02T06:00:00Z'),
      responses: [{ id: 51, authorName: 'Dr. K', authorRole: 'pi', body: 'Uncontrolled, HbA1c 9', createdAt: new Date('2026-10-02T08:00:00Z') }],
    }],
    events: [
      { action: 'claim', fromStatus: 'uncoded', toStatus: 'in_progress', byName: 'Asha Coder', at: new Date('2026-10-02T05:00:00Z'), reason: null },
      { action: 'reopen', fromStatus: 'finalised', toStatus: 'in_progress', byName: 'Admin A', at: new Date('2026-10-02T07:00:00Z'), reason: 'Wrong laterality' },
    ],
    issues: [
      { severity: 'warning', code: 'provisional_remaining', entry: { kind: 'diagnosis', id: 12 }, message: 'A provisional diagnosis remains' },
      { severity: 'error', code: 'not_coded', entry: { kind: 'procedure', id: 21 }, message: 'This procedure has no code' },
    ],
    ...o,
  }
}

const refresh = vi.fn()

async function renderAs(opts: { role?: string; status?: EncounterCodingStatus; data?: CodingWorkspace | null; id?: string } = {}) {
  vi.resetModules()
  refresh.mockClear()
  const role = opts.role ?? 'coder'
  const data = opts.data === undefined ? workspace(opts.status ?? 'in_progress') : opts.data
  const logAudit = vi.fn(async () => undefined)
  const getCodingWorkspace = vi.fn(async () => data)
  const listAllUsers = vi.fn(async () => [
    { id: 5, name: 'Asha Coder', email: 'asha@secret.example', role: 'coder', mfaEnabled: false },
    { id: 6, name: 'Dev Admin', email: 'dev@secret.example', role: 'admin', mfaEnabled: false },
  ])
  const listAllProviders = vi.fn(async () => [
    { id: 3, name: 'Dr. K', isActive: true, registrationNumber: 'REG-SECRET' },
    { id: 4, name: 'Dr. Gone', isActive: false, registrationNumber: 'REG-2' },
  ])
  const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester', userId: 5 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('@/lib/queries/coding-workspace', () => ({ getCodingWorkspace }))
  vi.doMock('@/lib/queries/users', () => ({ listAllUsers }))
  vi.doMock('@/lib/queries/providers', () => ({ listAllProviders }))
  vi.doMock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }), redirect, notFound }))
  const { default: Page } = await import('@/app/(dashboard)/coding/encounters/[id]/page')
  const rtl = await import('@testing-library/react')
  const run = () => Page({ params: Promise.resolve({ id: opts.id ?? '7' }) })
  return { rtl, run, logAudit, getCodingWorkspace, listAllUsers, notFound, redirect }
}

async function renderPage(opts: Parameters<typeof renderAs>[0] = {}) {
  const r = await renderAs(opts)
  const utils = r.rtl.render(await r.run())
  return { ...r, ...utils, screen: r.rtl.screen, within: r.rtl.within }
}

const buttonNames = (root: HTMLElement) =>
  Array.from(root.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())

describe('/coding/encounters/[id]', () => {
  it('shows notes read-only with no edit control', async () => {
    const { screen, within } = await renderPage()
    const notes = screen.getByRole('region', { name: 'Clinical notes (read-only, signed)' })
    expect(within(notes).getByText('Thirsty for weeks <b>not bold</b>')).toBeInTheDocument()
    expect(within(notes).getByText('Start metformin')).toBeInTheDocument()
    expect(within(notes).queryByRole('textbox')).toBeNull()
    expect(within(notes).queryByRole('button')).toBeNull()
    expect(notes.querySelector('b')).toBeNull()
  })

  it('finalised shows only Reopen', async () => {
    const { container, screen } = await renderPage({ status: 'finalised' })
    expect(buttonNames(container)).toEqual(['Reopen'])
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText(/coding is finalised/i)).toBeInTheDocument()
  })

  it('in_progress offers Mark coded and Raise query; a coder never sees Assign', async () => {
    const { screen } = await renderPage({ status: 'in_progress' })
    expect(screen.getByRole('button', { name: 'Mark coded' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Raise query' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^assign/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Finalise' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull()
  })

  it('a coder who does not hold the claim sees no actions the server would refuse', async () => {
    const other = (status: EncounterCodingStatus) => {
      const w = workspace(status)
      return { ...w, coding: { ...w.coding, assignedToUserId: 99, assignedToName: 'Other Coder' } }
    }
    const inProgress = await renderPage({ data: other('in_progress') })
    expect(buttonNames(inProgress.container)).not.toEqual(expect.arrayContaining(['Mark coded']))
    for (const name of ['Mark coded', 'Release', 'Raise query', 'Claim']) expect(inProgress.screen.queryByRole('button', { name })).toBeNull()
    expect(inProgress.screen.queryByRole('button', { name: /^close the query/i })).toBeNull()
    // Replying stays open to every coding role.
    expect(inProgress.screen.getByRole('button', { name: 'Send reply' })).toBeInTheDocument()
    cleanup()
    const finalised = await renderPage({ data: other('finalised') })
    expect(buttonNames(finalised.container)).toEqual([])
  })

  it('a visit that is not completed offers no coding actions', async () => {
    const w = workspace('uncoded')
    const { container } = await renderPage({ data: { ...w, encounter: { ...w.encounter, status: 'in_consultation', completedAt: null }, coding: { ...w.coding, assignedToUserId: null, assignedToName: null }, queries: [] } })
    expect(buttonNames(container)).toEqual([])
  })

  it('an admin sees Assign with a coder-only select that carries no email', async () => {
    const { screen, container, listAllUsers } = await renderPage({ role: 'admin', status: 'in_progress' })
    expect(listAllUsers).toHaveBeenCalled()
    const select = screen.getByRole('combobox', { name: /assign to/i })
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['Choose a coder', 'Asha Coder'])
    expect(screen.getByRole('button', { name: /^assign/i })).toBeInTheDocument()
    expect(container.innerHTML).not.toContain('secret.example')
  })

  it('a coder page never loads the staff list', async () => {
    const { listAllUsers } = await renderPage({ role: 'coder' })
    expect(listAllUsers).not.toHaveBeenCalled()
  })

  it('renders no dob, phone or address', async () => {
    const leaky = workspace('in_progress')
    // Even if the loader ever returned more, the page maps explicit view fields only.
    Object.assign(leaky.patient, { dob: '1972-03-14', phone: '+919876543210', address: '12 Secret Lane', aadhaarLast4: '9999' })
    const { container } = await renderPage({ data: leaky })
    for (const v of ['1972-03-14', '14 Mar 1972', '9876543210', 'Secret Lane', '9999', 'REG-SECRET']) expect(container.textContent).not.toContain(v)
    expect(container.textContent).toContain('UH-0001')
    expect(container.textContent).toContain('54 years')
    expect(container.textContent).toContain('Female')
  })

  it('a bad id or a missing encounter is a 404; the bad id never reaches the loader', async () => {
    const bad = await renderAs({ id: 'abc' })
    await expect(bad.run()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(bad.getCodingWorkspace).not.toHaveBeenCalled()
    const missing = await renderAs({ data: null })
    await expect(missing.run()).rejects.toThrow('NEXT_NOT_FOUND')
    expect(missing.logAudit).not.toHaveBeenCalled()
  })

  it('redirects a denied role before loading anything', async () => {
    const r = await renderAs({ role: 'pi' })
    await expect(r.run()).rejects.toThrow('NEXT_REDIRECT')
    expect(r.redirect).toHaveBeenCalledWith('/')
    expect(r.getCodingWorkspace).not.toHaveBeenCalled()
  })

  it('audits the view with the patient id and encounter', async () => {
    const { logAudit } = await renderPage()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'coder' }), 'coding: viewed coding workspace', 'P-1', 'encounter=7')
  })

  it('shows entry status chips, a Sample badge, and checks with errors first linked to their entries', async () => {
    const { screen, within } = await renderPage()
    expect(screen.getByText('Proposed by Dr. K')).toBeInTheDocument()
    expect(screen.getAllByText('Coded').length).toBeGreaterThan(0)
    expect(screen.getByText('Uncoded')).toBeInTheDocument()
    expect(screen.getAllByText('Sample').length).toBeGreaterThan(0)
    const checks = screen.getByRole('region', { name: 'Coding checks' })
    const items = within(checks).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('This procedure has no code')
    expect(items[1]).toHaveTextContent('A provisional diagnosis remains')
    expect(within(items[0]).getByRole('link')).toHaveAttribute('href', '#procedure-21')
    expect(document.getElementById('procedure-21')).not.toBeNull()
  })

  // SP6 Task 13: the loader now returns the proposer of a procedure too.
  it('names the doctor who proposed a procedure', async () => {
    const { screen } = await renderPage({
      data: workspace('in_progress', { procedures: [proc({ id: 22, codingStatus: 'proposed', proposedByName: 'Dr. Proc', codeId: 8, kind: 'hbp', code: 'SMP001A', display: 'SAMPLE fictional' })] }),
    })
    expect(screen.getByText('Proposed by Dr. Proc')).toBeInTheDocument()
  })

  it('shows the event history with the reopen reason and the query thread', async () => {
    const { screen } = await renderPage()
    expect(screen.getByText('Wrong laterality')).toBeInTheDocument()
    expect(screen.getByText('Uncontrolled, HbA1c 9')).toBeInTheDocument()
  })

  it('accepts a proposal with a PATCH of the same code, and shows a server error in an alert', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Claim this encounter before changing its codes' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 12, warnings: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { screen } = await renderPage()
    fireEvent.click(screen.getByRole('button', { name: /accept/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claim this encounter before changing its codes')
    expect(fetchMock).toHaveBeenCalledWith('/api/coding/encounters/7/diagnoses/12', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ codeId: 502 }) }))
    fireEvent.click(screen.getByRole('button', { name: /accept/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('reopen needs a reason and posts it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'in_progress', issues: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { screen } = await renderPage({ status: 'finalised' })
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    const dialog = await screen.findByRole('dialog', { name: /reopen coding/i })
    const confirm = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Reopen coding') as HTMLButtonElement
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox', { name: /reason/i }), { target: { value: 'Wrong side coded' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/coding/encounters/7/status', expect.objectContaining({ body: JSON.stringify({ action: 'reopen', reason: 'Wrong side coded' }) })))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('a refused mark-coded lists the blocking issues from the 422', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Coding checks failed; fix the errors listed',
      issues: [{ severity: 'error', code: 'primary_missing', entry: null, message: 'Add a primary diagnosis' }],
    }), { status: 422 })))
    const { screen } = await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Mark coded' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Coding checks failed; fix the errors listed')
    expect(alert).toHaveTextContent('Add a primary diagnosis')
  })
})
