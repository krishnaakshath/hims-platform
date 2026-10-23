// WS3 T3: the admission dialog (spec 3.1). Beds, payers and the deposit hint come from
// GET /api/inpatient/admissions/form-context; the dialog posts POST /api/inpatient/admissions.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react'
import { AdmitPatientModal } from '@/components/inpatient/AdmitPatientModal'
import { BedBoard, type BoardRoom } from '@/components/BedBoard'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

const ASHA = { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042' }
const PROVIDERS = [{ id: 1, name: 'Dr. Meera Iyer' }, { id: 2, name: 'Dr. R. Kunam' }]
const CONTEXT = {
  patient: { id: 'RD-0001', name: 'Asha Rao', uhid: 'UH00000042', gender: 'female', ageYears: 34 },
  beds: [
    { id: 10, label: 'Ward M 1-A', ward: 'Ward M', genderRestriction: 'male', roomCategoryName: 'General', tariffPaise: 150_000, conflict: 'opposite_sex' },
    { id: 11, label: 'Ward GEN 2-A', ward: 'Ward GEN', genderRestriction: null, roomCategoryName: null, tariffPaise: null, conflict: null },
  ],
  policies: [
    { id: 7, label: 'Star Health SH-1', insurerName: 'Star Health', validTo: '2099-12-31' },
    { id: 8, label: 'HDFC Ergo HE-2', insurerName: 'HDFC Ergo', validTo: '2099-12-31' },
  ],
  preauths: [
    { id: 21, preauthNumber: 'PA-21', status: 'approved', approvedPaise: 5_000_000, policyId: 7 },
    { id: 22, preauthNumber: 'PA-22', status: 'requested', approvedPaise: null, policyId: 8 },
  ],
  openOpdEncounter: { id: 55, opdToken: 12, providerName: 'Dr. Meera Iyer' },
  activeAdmissionId: null,
  depositThresholdPaise: 500_000,
}
const CODES = {
  codeSystem: { id: 1, version: '2019', isSample: false },
  hits: [{ id: 501, kind: 'icd10', code: 'K40.9', display: 'Unilateral inguinal hernia', selectable: true, version: '2019', isSample: false }],
}
const CREATED = {
  admissionId: 3, encounterId: 9, patientId: 'RD-0001', uhid: 'UH00000042', roomLabel: 'Ward GEN 2-A', depositRequiredPaise: 600_000,
  cashDeskHref: '/cash-desk?patientId=RD-0001&amountPaise=600000',
}

type Reply = { status: number; body: unknown }
function stubFetch(posts: Reply[], context: unknown = CONTEXT) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/inpatient/admissions/form-context')) return new Response(JSON.stringify(context), { status: 200 })
    if (url.startsWith('/api/coding/codes')) return new Response(JSON.stringify(CODES), { status: 200 })
    if (url === '/api/inpatient/admissions' && init?.method === 'POST') {
      const r = posts.shift() ?? { status: 500, body: {} }
      return new Response(JSON.stringify(r.body), { status: r.status })
    }
    if (url.startsWith('/api/patients/lookup')) {
      return new Response(JSON.stringify({ results: [{ ...ASHA, gender: 'female', ageYears: 34 }], page: 1, pageSize: 10, hasMore: false }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
const postBodies = (m: ReturnType<typeof stubFetch>) =>
  m.mock.calls.filter(([u, i]) => u === '/api/inpatient/admissions' && i?.method === 'POST').map(([, i]) => JSON.parse(i!.body as string))

async function open(props: Partial<Parameters<typeof AdmitPatientModal>[0]> = {}) {
  render(<AdmitPatientModal patient={ASHA} providers={PROVIDERS} onClose={vi.fn()} {...props} />)
  await screen.findByRole('combobox', { name: 'Bed' })
}
function fillRequired(bed = '11') {
  fireEvent.change(screen.getByRole('combobox', { name: 'Attending doctor' }), { target: { value: '1' } })
  fireEvent.change(screen.getByLabelText('Reason for admission'), { target: { value: 'Planned hernia repair' } })
  fireEvent.click(screen.getByRole('button', { name: /type instead/i }))
  fireEvent.change(screen.getByLabelText('Provisional diagnosis'), { target: { value: 'Inguinal hernia' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Bed' }), { target: { value: bed } })
}
const admit = () => screen.getByRole('button', { name: 'Admit' })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('AdmitPatientModal', () => {
  it('lists only the free beds from the form context, with the tariff', async () => {
    const f = stubFetch([])
    await open()
    expect(f.mock.calls[0][0]).toBe('/api/inpatient/admissions/form-context?patientId=RD-0001')
    const options = within(screen.getByRole('combobox', { name: 'Bed' })).getAllByRole('option').filter((o) => (o as HTMLOptionElement).value !== '')
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(['10', '11'])
    expect(options[0].textContent).toContain('₹1,500/day')
    expect(screen.getByText(/UHID UH00000042/)).toBeInTheDocument()
  })

  it('a conflicting bed says why and disables Admit until a 10-character override reason is typed', async () => {
    const f = stubFetch([{ status: 201, body: CREATED }])
    await open()
    fillRequired('11')
    expect(admit()).toBeEnabled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Bed' }), { target: { value: '10' } })
    expect(screen.getByText('Female patient, male ward')).toBeInTheDocument()
    expect(admit()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'too short' } })
    expect(admit()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Override reason'), { target: { value: 'Only free bed tonight' } })
    expect(admit()).toBeEnabled()
    fireEvent.click(admit())
    await waitFor(() => expect(postBodies(f)).toHaveLength(1))
    expect(postBodies(f)[0]).toMatchObject({ roomId: 10, wardGenderOverrideReason: 'Only free bed tonight' })
  })

  it('posts the exact admission body (ICD-10 code, attendant, policy, pre-auth, deposit in paise)', async () => {
    const f = stubFetch([{ status: 201, body: CREATED }])
    await open()
    fireEvent.change(screen.getByRole('combobox', { name: 'Admission type' }), { target: { value: 'emergency' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Attending doctor' }), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Reason for admission'), { target: { value: 'Planned hernia repair' } })
    fireEvent.change(screen.getByRole('combobox', { name: /provisional diagnosis/i }), { target: { value: 'K40' } })
    fireEvent.click(await screen.findByRole('option', { name: /K40\.9/ }))
    expect(screen.getByText(/Unilateral inguinal hernia/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Expected stay (days)'), { target: { value: '4' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Bed' }), { target: { value: '11' } })
    fireEvent.change(screen.getByLabelText('Attendant name'), { target: { value: 'Ravi Rao' } })
    fireEvent.change(screen.getByLabelText('Attendant relationship'), { target: { value: 'Husband' } })
    fireEvent.change(screen.getByLabelText('Attendant phone'), { target: { value: '9876543210' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Payer' }), { target: { value: '7' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Pre-authorisation' }), { target: { value: '21' } })
    expect(screen.getByLabelText('Deposit required (₹)')).toHaveValue('5000')
    fireEvent.change(screen.getByLabelText('Deposit required (₹)'), { target: { value: '6,000' } })
    fireEvent.click(admit())
    await waitFor(() => expect(postBodies(f)).toHaveLength(1))
    expect(postBodies(f)[0]).toEqual({
      patientId: 'RD-0001', attendingProviderId: 2, roomId: 11, admissionType: 'emergency', reason: 'Planned hernia repair',
      provisionalDiagnosis: { codeId: 501 }, expectedStayDays: 4,
      attendant: { name: 'Ravi Rao', relationship: 'Husband', phone: '9876543210' },
      policyId: 7, preauthId: 21, depositRequiredPaise: 600_000, wardGenderOverrideReason: null, openOpdVisit: null,
    })
  })

  it('posts typed diagnosis text, self-pay and no attendant; hides pre-auth for self-pay and filters it by policy', async () => {
    const f = stubFetch([{ status: 201, body: CREATED }])
    await open()
    fillRequired()
    expect(screen.queryByRole('combobox', { name: 'Pre-authorisation' })).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: 'Payer' }), { target: { value: '8' } })
    const pa = within(screen.getByRole('combobox', { name: 'Pre-authorisation' })).getAllByRole('option').map((o) => o.textContent)
    expect(pa.some((t) => t?.includes('PA-22'))).toBe(true)
    expect(pa.some((t) => t?.includes('PA-21'))).toBe(false)
    fireEvent.change(screen.getByRole('combobox', { name: 'Payer' }), { target: { value: '' } })
    expect(screen.queryByRole('combobox', { name: 'Pre-authorisation' })).not.toBeInTheDocument()
    fireEvent.click(admit())
    await waitFor(() => expect(postBodies(f)).toHaveLength(1))
    expect(postBodies(f)[0]).toMatchObject({
      provisionalDiagnosis: { text: 'Inguinal hernia' }, attendant: null, policyId: null, preauthId: null, depositRequiredPaise: 500_000, expectedStayDays: 1,
    })
  })

  it('a partly filled attendant blocks Admit', async () => {
    stubFetch([])
    await open()
    fillRequired()
    fireEvent.change(screen.getByLabelText('Attendant name'), { target: { value: 'Ravi Rao' } })
    expect(admit()).toBeDisabled()
  })

  it('on an open OPD visit asks how to handle it and re-posts with the choice', async () => {
    const f = stubFetch([
      { status: 409, body: { error: 'The patient has an open OPD visit today.', code: 'open_opd_visit', openEncounterId: 55 } },
      { status: 201, body: CREATED },
    ])
    await open()
    fillRequired()
    fireEvent.click(admit())
    expect(await screen.findByText('This patient has an open OPD visit (token 12 with Dr. Meera Iyer)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Keep it open and admit' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Complete it and admit' }))
    await waitFor(() => expect(postBodies(f)).toHaveLength(2))
    expect(postBodies(f)[1]).toMatchObject({ openOpdVisit: 'complete', roomId: 11 })
    expect(await screen.findByText('Patient admitted')).toBeInTheDocument()
  })

  it('success shows the UHID, the bed and the cash desk link, never a token or the chart id', async () => {
    stubFetch([{ status: 201, body: CREATED }])
    await open()
    fillRequired()
    fireEvent.click(admit())
    expect(await screen.findByText('Patient admitted')).toBeInTheDocument()
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(/UH00000042/)).toBeInTheDocument()
    expect(within(dialog).getByText('Ward GEN 2-A')).toBeInTheDocument()
    expect(within(dialog).getByRole('link', { name: /collect deposit/i })).toHaveAttribute('href', CREATED.cashDeskHref)
    expect(dialog.textContent).not.toMatch(/token/i)
    expect(dialog.textContent).not.toContain('RD-0001')
  })

  it('shows a refusal message and keeps the form', async () => {
    stubFetch([{ status: 409, body: { error: 'That bed is no longer available. Please choose another.', code: 'room_unavailable' } }])
    await open()
    fillRequired()
    fireEvent.click(admit())
    expect(await screen.findByRole('alert')).toHaveTextContent('That bed is no longer available')
    expect(admit()).toBeInTheDocument()
  })

  it('says when the patient is already admitted and does not offer Admit', async () => {
    stubFetch([], { ...CONTEXT, activeAdmissionId: 4 })
    render(<AdmitPatientModal patient={ASHA} providers={PROVIDERS} onClose={vi.fn()} />)
    expect(await screen.findByText(/already admitted/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Admit' })).not.toBeInTheDocument()
  })

  it('preselects the bed it was opened for', async () => {
    stubFetch([])
    await open({ initialRoomId: 11 })
    expect(screen.getByRole('combobox', { name: 'Bed' })).toHaveValue('11')
  })
})

describe('BedBoard "Admit here"', () => {
  const FREE: BoardRoom = {
    id: 11, ward: 'Ward GEN', roomNumber: '2', bedNumber: 'A', status: 'available', blockedReason: null,
    occupantName: null, occupantPatientId: null, attendingProviderName: null, admittedAt: null,
  }

  it('opens the admission dialog for the picked patient with the bed preselected', async () => {
    stubFetch([])
    render(<BedBoard rooms={[FREE]} providers={PROVIDERS} canManageFacilities={false} canBlock={false} canAdmit />)
    fireEvent.click(screen.getByRole('button', { name: /Room 2 · Bed A/ }))
    expect(screen.getByRole('button', { name: 'Admit here' })).toBeDisabled()
    fireEvent.change(screen.getByRole('combobox', { name: /patient/i }), { target: { value: 'Asha' } })
    fireEvent.click(await screen.findByRole('option', { name: /asha rao/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Admit here' }))
    expect(await screen.findByRole('combobox', { name: 'Bed' })).toHaveValue('11')
  })

  it('offers no "Admit here" without the admission role', () => {
    render(<BedBoard rooms={[FREE]} providers={PROVIDERS} canManageFacilities={false} canBlock={false} canAdmit={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Room 2 · Bed A/ }))
    expect(screen.queryByRole('button', { name: 'Admit here' })).not.toBeInTheDocument()
  })
})
