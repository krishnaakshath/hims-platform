import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { AddClientModal } from '@/components/AddClientModal'
import { RegistrationStepper } from '@/components/registration/RegistrationStepper'

// WS6 T8: registration in four steps with a progress bar, per-step validation, referral
// source, photo upload after registration and the "Next available" hint.
const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
let handler: Handler
let fetchMock: ReturnType<typeof vi.fn>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const DOCTORS = [
  { id: 11, name: 'Rao', departmentId: 3, departmentName: 'General Medicine', opdRoom: '4' },
  { id: 12, name: 'Dr. Mehta', departmentId: 3, departmentName: 'General Medicine', opdRoom: null },
  { id: 13, name: 'Iyer', departmentId: 5, departmentName: 'Paediatrics', opdRoom: '7' },
]
const slot = (hhmmUtc: string, status = 'free') => ({ startsAt: `2026-10-23T${hhmmUtc}:00.000Z`, endsAt: `2026-10-23T${hhmmUtc}:00.000Z`, status })

beforeEach(() => {
  push.mockClear()
  window.sessionStorage.clear()
  handler = (url) => {
    if (url === '/api/payers') return json([])
    if (url === '/api/providers') return json({ doctors: DOCTORS })
    if (url.startsWith('/api/providers/11/slots')) return json({ slots: [slot('05:30', 'booked'), slot('06:00')] }) // 11:30 IST
    if (url.startsWith('/api/providers/12/slots')) return json({ slots: [slot('07:00')] }) // 12:30 IST
    if (url === '/api/patients') return json({ id: 'RD-0042', uhid: 'UH000000042' }, 201)
    if (url.endsWith('/photo')) return json({ ok: true }, 201)
    return json({}, 404)
  }
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const renderModal = (props: Partial<Parameters<typeof AddClientModal>[0]> = {}) =>
  render(<ToastProvider><AddClientModal onClose={vi.fn()} {...props} /></ToastProvider>)
const next = () => screen.getByRole('button', { name: 'Next' })
const change = (labelText: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(labelText), { target: { value } })

function fillIdentity() {
  change('Full name', 'Asha Rao')
  change('Date of birth', '1990-05-01')
  change('Gender', 'female')
}
function fillAddress() {
  change('Address line 1', '12 MG Road')
  change('City', 'Bengaluru')
  change('District', 'Bengaluru Urban')
  change('State / UT', 'IN-KA')
  change('PIN code', '560001')
}
function fillIds() {
  fireEvent.click(screen.getByLabelText('Patient does not provide Aadhaar'))
  change('Reason for no Aadhaar', 'patient_declined')
  fireEvent.click(screen.getByLabelText('ABHA not available'))
  change('Reason ABHA is not available', 'not_created')
}
async function toReview() {
  fillIdentity(); fireEvent.click(next())
  fillAddress(); fireEvent.click(next())
  fillIds(); fireEvent.click(next())
  await screen.findByRole('region', { name: 'Review' })
}

describe('RegistrationStepper', () => {
  it('reads "Step 2 of 4" with a progress bar', () => {
    render(<RegistrationStepper steps={['A', 'B', 'C', 'D']} current={1} />)
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
  })
})

describe('AddClientModal in steps (WS6 T8)', () => {
  it('keeps Next disabled while step 1 has errors', () => {
    renderModal()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(next()).toBeDisabled()
    change('Full name', 'Asha Rao')
    change('Date of birth', '1990-05-01')
    expect(next()).toBeDisabled() // gender still missing
    change('Gender', 'female')
    expect(next()).toBeEnabled()
  })

  it('progresses to "Step 3 of 4" and Back keeps the values', () => {
    renderModal()
    fillIdentity(); fireEvent.click(next())
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    fillAddress(); fireEvent.click(next())
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('PIN code')).toHaveValue('560001')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Full name')).toHaveValue('Asha Rao')
    expect(screen.getByLabelText('Gender')).toHaveValue('female')
  })

  it('a doctor referral requires the referring doctor', () => {
    renderModal()
    fillIdentity()
    change('Referral source', 'doctor')
    expect(screen.getByText('Name the referring doctor')).toBeInTheDocument()
    expect(next()).toBeDisabled()
    change('Referring doctor', 'Dr Kulkarni, Jayanagar')
    expect(next()).toBeEnabled()
  })

  it('registers with the referral source, uploads the photo, and the toast offers check-in and the slip', async () => {
    renderModal({ navigateToPatient: false })
    fillIdentity()
    change('Referral source', 'camp')
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'p.jpg', { type: 'image/jpeg' })
    fireEvent.change(screen.getByLabelText('Patient photo file'), { target: { files: [photo] } })
    fireEvent.click(next()); fillAddress(); fireEvent.click(next()); fillIds(); fireEvent.click(next())
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const status = await screen.findByText('Patient registered')
    const toastEl = status.closest('[role="status"]') as HTMLElement
    // hidden: the test's onClose does not unmount the dialog, which aria-hides the page behind it.
    expect(within(toastEl).getByRole('link', { name: 'Check in now', hidden: true })).toHaveAttribute('href', '/front-desk/check-in?patient=RD-0042')
    expect(within(toastEl).getByRole('link', { name: 'Print registration slip', hidden: true })).toHaveAttribute('href', '/print/registration/RD-0042')
    const reg = fetchMock.mock.calls.find((c) => c[0] === '/api/patients')!
    expect(JSON.parse(String(reg[1]?.body))).toMatchObject({ referralSource: 'camp' })
    const photoCall = fetchMock.mock.calls.find((c) => c[0] === '/api/patients/RD-0042/photo')!
    expect(photoCall[1]?.method).toBe('POST')
    expect((photoCall[1]?.body as FormData).get('file')).toBeInstanceOf(File)
  })

  it('a failed photo upload leaves the patient registered and shows an error toast', async () => {
    const base = handler
    handler = (url, init) => (url.endsWith('/photo') ? json({ error: 'The photo must be 2 MB or smaller' }, 400) : base(url, init))
    const onClose = vi.fn()
    renderModal({ onClose })
    fillIdentity()
    fireEvent.change(screen.getByLabelText('Patient photo file'), { target: { files: [new File([new Uint8Array([1])], 'p.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(next()); fillAddress(); fireEvent.click(next()); fillIds(); fireEvent.click(next())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Photo not saved')).toBeInTheDocument()
    expect(screen.getByText('Patient registered')).toBeInTheDocument()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/patients/RD-0042?registered=1'))
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps a draft in sessionStorage without any identifier and clears it on success', async () => {
    const first = renderModal()
    fillIdentity()
    fireEvent.click(next()); fillAddress(); fireEvent.click(next())
    change('Aadhaar number', '234567890124')
    change('ABHA number', '91234567890123')
    change('Other ID document type', 'pan')
    change('ID document number', 'ABCDE1234F')
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    const raw = window.sessionStorage.getItem('hims.registration-draft.v1') ?? ''
    expect(JSON.parse(raw)).toMatchObject({ step: 1, form: { name: 'Asha Rao', aadhaarNumber: '', abhaNumber: '', kycDocNumber: '', kycDocType: 'pan' } })
    expect(raw).not.toMatch(/234567890124|91234567890123|ABCDE1234F/)
    first.unmount()

    renderModal()
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText(/Restored an unsaved registration/)).toBeInTheDocument()
    fillAddress(); fireEvent.click(next()); fillIds()
    change('Other ID document type', '') // the restored type came back without its (never kept) number
    fireEvent.click(next())
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Patient registered')
    expect(window.sessionStorage.getItem('hims.registration-draft.v1')).toBeNull()
  })

  it('keeps no draft for a dialog closed before anything was typed', () => {
    renderModal().unmount()
    expect(window.sessionStorage.getItem('hims.registration-draft.v1')).toBeNull()
    renderModal()
    expect(screen.queryByText(/Restored an unsaved registration/)).toBeNull()
  })

  it('survives sessionStorage throwing', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    renderModal()
    fillIdentity()
    expect(next()).toBeEnabled()
    spy.mockRestore(); set.mockRestore()
  })

  it('shows the earliest free doctor of the chosen department on Review', async () => {
    renderModal()
    await toReview()
    change('Department to see (optional)', '3')
    expect(await screen.findByText('Next available: Dr Rao today 11:30 am · Room 4')).toBeInTheDocument()
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith('/api/providers/13/'))).toBe(false)
  })

  it('hides the hint when the slots route answers 404', async () => {
    const base = handler
    handler = (url, init) => (url.includes('/slots') ? json({ error: 'Not found' }, 404) : base(url, init))
    renderModal()
    await toReview()
    change('Department to see (optional)', '3')
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/slots'))).toBe(true))
    await waitFor(() => expect(screen.queryByText(/Checking today/)).toBeNull())
    expect(screen.queryByText(/Next available/)).toBeNull()
  })

  it('hides the department choice entirely when the doctor list is unavailable', async () => {
    const base = handler
    handler = (url, init) => (url === '/api/providers' ? json({ error: 'Not found' }, 404) : base(url, init))
    renderModal()
    await toReview()
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0] === '/api/providers')).toBe(true))
    expect(screen.queryByLabelText('Department to see (optional)')).toBeNull()
  })
})
