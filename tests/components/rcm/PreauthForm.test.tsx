import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { PreauthForm } from '@/components/rcm/PreauthForm'
import { PreauthActions } from '@/components/rcm/PreauthActions'

afterEach(() => vi.unstubAllGlobals())

const PROPS = { policies: [{ id: 2, label: 'Star · POL/1 (primary)' }], admissions: [], encounters: [], doctors: [{ id: 4, name: 'Dr X' }] }

describe('PreauthForm', () => {
  it('shows the live estimate with price sources and an unpriced service message', async () => {
    let unpriced = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/tariff/services')) return new Response(JSON.stringify({ services: [{ id: 7, code: 'SVC7', name: 'Appendicectomy' }, { id: 9, code: 'SVC9', name: 'Unpriced' }] }))
      if (url === '/api/rcm/preauths/estimate') {
        return unpriced
          ? new Response(JSON.stringify({ error: 'No tariff rate covers SVC9' }), { status: 422 })
          : new Response(JSON.stringify({ lines: [{ serviceId: 7, code: 'SVC7', name: 'Appendicectomy', quantity: 1, unitPricePaise: 50_000_00, amountPaise: 50_000_00, priceSource: 'payer' }], totalPaise: 50_000_00 }))
      }
      return new Response('{}', { status: 404 })
    }))
    render(<PreauthForm {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Planned admission date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'SVC7 · Appendicectomy' }))
    expect(await screen.findByText('Payer rate', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText('Estimate ₹50,000.00')).toBeInTheDocument()
    unpriced = true
    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'unp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'SVC9 · Unpriced' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No tariff rate covers SVC9'), { timeout: 2000 })
  })
})

// ---- WS12 T8: defaults from the admission, the explained submit and the amount check ----------
describe('PreauthForm (WS12 T8)', () => {
  const ADM_PROPS = {
    policies: [{ id: 2, label: 'Star · POL/1 (primary)' }, { id: 5, label: 'Care · POL/2 (secondary)' }],
    admissions: [{ id: 11, admittedOn: '2026-10-20', status: 'admitted' }], encounters: [],
    doctors: [{ id: 4, name: 'Dr X' }, { id: 8, name: 'Dr Y' }],
  }
  const DEFAULTS = { admissionId: 11, encounterId: null, claimType: 'ipd' as const, plannedAdmissionDate: '2026-10-20', treatingProviderId: 8, policyId: 5, roomCategoryCode: 'ICU' }
  const estimateFetch = (totalPaise: number) => vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/tariff/services')) return new Response(JSON.stringify({ services: [{ id: 7, code: 'SVC7', name: 'Bed day' }] }))
    if (url === '/api/rcm/preauths/estimate') {
      return new Response(JSON.stringify({ lines: [{ serviceId: 7, code: 'SVC7', name: 'Bed day', quantity: 1, unitPricePaise: totalPaise, amountPaise: totalPaise, priceSource: 'base' }], totalPaise, coverage: null }))
    }
    if (url === '/api/rcm/preauths' && init?.method === 'POST') {
      return new Response(JSON.stringify({ preauthId: 3, preauthNumber: 'PA-2026-000003', eligibility: { started: false, message: 'NHCX not configured: record a manual verification' } }), { status: 201 })
    }
    return new Response('{}', { status: 404 })
  })
  const addService = async () => {
    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'bed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'SVC7 · Bed day' }))
  }

  it('with no defaults the doctor is not chosen, and the button says what is missing', () => {
    render(<PreauthForm {...PROPS} />)
    expect(screen.getByLabelText('Treating doctor')).toHaveValue('')
    const button = screen.getByRole('button', { name: 'Create draft pre-authorisation' })
    expect(button).toBeDisabled()
    const why = screen.getByText(/^To create the draft, add:/)
    expect(why).toHaveTextContent('To create the draft, add: planned admission date, treating doctor, a diagnosis code or provisional diagnosis, at least one estimate line')
    expect(button).toHaveAttribute('aria-describedby', why.id)
  })

  it('names only the planned admission date when only it is missing', async () => {
    vi.stubGlobal('fetch', estimateFetch(600_00))
    render(<PreauthForm {...ADM_PROPS} defaults={{ ...DEFAULTS, plannedAdmissionDate: null }} />)
    fireEvent.change(screen.getByLabelText('Provisional diagnosis (free text)'), { target: { value: 'Fever' } })
    await addService()
    expect(screen.getByText(/^To create the draft, add:/)).toHaveTextContent(/^To create the draft, add: planned admission date$/)
  })

  it('pre-fills the date, doctor, admission, policy and room from the admission', () => {
    render(<PreauthForm {...ADM_PROPS} defaults={DEFAULTS} />)
    expect(screen.getByLabelText('Planned admission date')).toHaveValue('2026-10-20')
    expect(screen.getByLabelText('Treating doctor')).toHaveValue('8')
    expect(screen.getByLabelText('Admission (if already admitted)')).toHaveValue('11')
    expect(screen.getByLabelText('Policy')).toHaveValue('5')
    expect(screen.getByLabelText('Room category code')).toHaveValue('ICU')
  })

  it('a requested amount far above the estimate warns and needs the confirm box; the create shows the eligibility message first', async () => {
    const fetchMock = estimateFetch(600_00)
    vi.stubGlobal('fetch', fetchMock)
    render(<PreauthForm {...ADM_PROPS} defaults={DEFAULTS} />)
    fireEvent.change(screen.getByLabelText('Provisional diagnosis (free text)'), { target: { value: 'Fever' } })
    await addService()
    expect(await screen.findByText('Estimate ₹600.00', {}, { timeout: 2000 })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Requested amount/), { target: { value: '90000' } })
    expect(screen.getByText('The requested ₹90,000.00 is 14,900% above the estimate of ₹600.00. Check the amount, or confirm it below.')).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Create draft pre-authorisation' })
    expect(button).toBeDisabled()
    expect(screen.getByText(/^To create the draft, add:/)).toHaveTextContent('confirmation of the requested amount')
    fireEvent.click(screen.getByLabelText('I have checked the requested amount'))
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(await screen.findByText('NHCX not configured: record a manual verification')).toBeInTheDocument()
    expect(screen.getByText(/PA-2026-000003/)).toBeInTheDocument()
    const body = JSON.parse(String(fetchMock.mock.calls.find((c) => c[0] === '/api/rcm/preauths')?.[1]?.body))
    expect(body).toMatchObject({ policyId: 5, admissionId: 11, treatingProviderId: 8, plannedAdmissionDate: '2026-10-20', requestedPaise: 90_000_00, roomCategoryCode: 'ICU' })
    expect(screen.getByRole('button', { name: 'Open the pre-authorisation' })).toBeInTheDocument()
  })

  it('clears the amount confirmation when the estimate total changes', async () => {
    let total = 600_00
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/tariff/services')) return new Response(JSON.stringify({ services: [{ id: 7, code: 'SVC7', name: 'Bed day' }] }))
      if (url === '/api/rcm/preauths/estimate') {
        return new Response(JSON.stringify({ lines: [{ serviceId: 7, code: 'SVC7', name: 'Bed day', quantity: 1, unitPricePaise: total, amountPaise: total, priceSource: 'base' }], totalPaise: total, coverage: null }))
      }
      return new Response('{}', { status: 404 })
    }))
    render(<PreauthForm {...ADM_PROPS} defaults={DEFAULTS} />)
    fireEvent.change(screen.getByLabelText('Provisional diagnosis (free text)'), { target: { value: 'Fever' } })
    await addService()
    expect(await screen.findByText('Estimate ₹600.00', {}, { timeout: 2000 })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/^Requested amount/), { target: { value: '90000' } })
    fireEvent.click(screen.getByLabelText('I have checked the requested amount'))
    const button = screen.getByRole('button', { name: 'Create draft pre-authorisation' })
    expect(button).toBeEnabled()
    total = 500_00
    fireEvent.change(screen.getByLabelText('Expected stay (days)'), { target: { value: '2' } })
    expect(await screen.findByText('Estimate ₹500.00', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByLabelText('I have checked the requested amount')).not.toBeChecked()
    expect(button).toBeDisabled()
  })

  it('shows the indicative insurer/patient split and its warnings from the estimate route', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/tariff/services')) return new Response(JSON.stringify({ services: [{ id: 7, code: 'SVC7', name: 'Bed day' }] }))
      if (url === '/api/rcm/preauths/estimate') {
        return new Response(JSON.stringify({
          lines: [{ serviceId: 7, code: 'SVC7', name: 'Bed day', quantity: 3, unitPricePaise: 5_000_00, amountPaise: 15_000_00, priceSource: 'base' }], totalPaise: 15_000_00,
          coverage: { insurerPaise: 9_000_00, patientPaise: 6_000_00, warnings: ['Room charge of ₹5,000.00 a day is over the policy room rent limit of ₹3,000.00 a day: ₹6,000.00 for 3 days is payable by the patient.'] },
        }))
      }
      return new Response('{}', { status: 404 })
    }))
    render(<PreauthForm {...ADM_PROPS} defaults={DEFAULTS} />)
    await addService()
    expect(await screen.findByText(/Indicative/, {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText(/Insurer ₹9,000.00/)).toBeInTheDocument()
    expect(screen.getByText(/Patient ₹6,000.00/)).toBeInTheDocument()
    expect(screen.getByText(/over the policy room rent limit/)).toBeInTheDocument()
  })
})

describe('PreauthActions', () => {
  it('offers only the allowed actions for the status', () => {
    render(<PreauthActions preauthId={1} status="approved" enhancedBefore={false} openQueryId={null} rejectionReasons={[]} />)
    expect(screen.getByText('Request enhancement', { selector: 'summary' })).toBeInTheDocument()
    expect(screen.getByText('Cancel', { selector: 'summary' })).toBeInTheDocument()
    expect(screen.queryByText('Record approval', { selector: 'summary' })).not.toBeInTheDocument()
    expect(screen.getAllByText(/./, { selector: 'summary' }).map((s) => s.textContent)).toEqual(['Request enhancement', 'Cancel'])
  })
})
