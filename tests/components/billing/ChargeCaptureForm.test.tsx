import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ChargeCaptureForm } from '@/components/billing/ChargeCaptureForm'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

const SERVICE = { id: 3, code: 'PROC1', name: 'Wound dressing', departmentId: 1, departmentName: 'General', category: 'procedure', hsnSac: '999312', gstRateBp: 1800, isActive: true }
const BLOCK = { code: 'preauth_required', severity: 'block', message: 'This payer needs a pre-authorisation reference for this service', field: 'preAuthReference', overridable: false }
const DUP = { code: 'duplicate_charge', severity: 'block', message: 'This service is already charged for this visit on this date', field: 'serviceId', overridable: true }
const WARN = { code: 'department_mismatch', severity: 'warn', message: 'This service belongs to a different department from the visit', field: 'context', overridable: false }

function preview(violations: unknown[], over: Record<string, unknown> = {}) {
  return {
    preview: {
      price: { ok: true }, unitPricePaise: 50000, priceSource: 'payer', taxablePaise: 50000,
      estimatedTax: { cgstRateBp: 900, sgstRateBp: 900, igstRateBp: 0, cgstPaise: 4500, sgstPaise: 4500, igstPaise: 0, taxPaise: 9000, totalPaise: 59000 },
      violations, unresolved: violations.filter((v) => (v as { severity: string }).severity === 'block').map((v) => (v as { code: string }).code), ...over,
    },
  }
}

let previewBody: unknown = preview([])
let captureResponse: { status: number; body: unknown } = { status: 201, body: { line: { id: 1 }, violations: [] } }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  refresh.mockClear()
  previewBody = preview([])
  captureResponse = { status: 201, body: { line: { id: 1 }, violations: [] } }
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/tariff/services')) return new Response(JSON.stringify({ services: [SERVICE] }), { status: 200 })
    if (url === '/api/billing/charge-lines/preview') return new Response(JSON.stringify(previewBody), { status: 200 })
    if (url === '/api/billing/charge-lines') return new Response(JSON.stringify(captureResponse.body), { status: captureResponse.status })
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

async function pickService() {
  fireEvent.change(screen.getByLabelText('Search service'), { target: { value: 'dress' } })
  fireEvent.click(await screen.findByRole('button', { name: /Wound dressing/ }))
}

const ctx = { encounterId: 5 }

describe('ChargeCaptureForm', () => {
  it('shows the resolved price and a blocking violation from the preview', async () => {
    previewBody = preview([BLOCK])
    render(<ChargeCaptureForm context={ctx} canOverride={false} hasPayer today="2099-06-01" />)
    await pickService()
    expect(await screen.findByText('Payer rate')).toBeInTheDocument()
    expect(screen.getAllByText('₹500.00').length).toBeGreaterThan(0)
    expect(screen.getByText('This payer needs a pre-authorisation reference for this service')).toBeInTheDocument()
    expect(screen.getByText('₹90.00')).toBeInTheDocument()
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/billing/charge-lines/preview')![1].body)
    expect(body).toMatchObject({ context: ctx, serviceId: 3, quantity: 1, serviceDate: '2099-06-01', billTo: 'patient' })
  })

  it('hides the manual price field when canOverride is false', () => {
    const { unmount } = render(<ChargeCaptureForm context={ctx} canOverride={false} hasPayer={false} today="2099-06-01" />)
    expect(screen.queryByLabelText('Manual unit price (₹)')).toBeNull()
    expect(screen.getByRole('option', { name: /Payer/ })).toBeDisabled()
    unmount()
    render(<ChargeCaptureForm context={ctx} canOverride hasPayer today="2099-06-01" />)
    expect(screen.getByLabelText('Manual unit price (₹)')).toBeInTheDocument()
  })

  it('override reason input appears only for overridable blocks and only for authority roles', async () => {
    previewBody = preview([DUP, BLOCK, WARN])
    const { unmount } = render(<ChargeCaptureForm context={ctx} canOverride hasPayer today="2099-06-01" />)
    await pickService()
    expect(await screen.findByLabelText('Override reason: No duplicate charge on the same day')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Override reason: Pre-authorisation/)).toBeNull()
    expect(screen.queryByLabelText(/Override reason: Service belongs/)).toBeNull()
    unmount()
    render(<ChargeCaptureForm context={ctx} canOverride={false} hasPayer today="2099-06-01" />)
    await pickService()
    await screen.findByText('This service is already charged for this visit on this date')
    expect(screen.queryByLabelText(/Override reason/)).toBeNull()
  })

  it('a 422 on submit lists the violations and keeps the inputs', async () => {
    captureResponse = { status: 422, body: { error: 'This charge breaks billing rules', violations: [DUP] } }
    render(<ChargeCaptureForm context={ctx} canOverride={false} hasPayer today="2099-06-01" />)
    await pickService()
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '2' } })
    await screen.findByText('Payer rate')
    fireEvent.click(screen.getByRole('button', { name: 'Add charge' }))
    expect(await screen.findByText('This charge breaks billing rules')).toBeInTheDocument()
    expect(screen.getByText('This service is already charged for this visit on this date')).toBeInTheDocument()
    expect(screen.getByLabelText('Quantity')).toHaveValue(2)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('a 201 resets the form and refreshes the page; a manual price is sent in paise', async () => {
    render(<ChargeCaptureForm context={ctx} canOverride hasPayer today="2099-06-01" />)
    await pickService()
    fireEvent.change(screen.getByLabelText('Manual unit price (₹)'), { target: { value: '1,250.50' } })
    fireEvent.change(screen.getByLabelText('Reason for manual price'), { target: { value: 'Agreed package rate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add charge' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/billing/charge-lines')![1].body)
    expect(body).toMatchObject({ manualUnitPricePaise: 125050, priceOverrideReason: 'Agreed package rate' })
    expect(screen.getByLabelText('Search service')).toHaveValue('')
  })

  it('procedure codes pick a code system from the list the service map uses', async () => {
    render(<ChargeCaptureForm context={ctx} canOverride={false} hasPayer today="2099-06-01" />)
    await pickService()
    fireEvent.click(screen.getByRole('button', { name: /Add procedure code/ }))
    const kind = screen.getByLabelText('Code system 1') as HTMLSelectElement
    expect(kind.tagName).toBe('SELECT')
    expect(Array.from(kind.options).map((o) => o.value)).toEqual(['icd10pcs', 'snomed', 'hbp', 'loinc'])
    fireEvent.change(kind, { target: { value: 'hbp' } })
    fireEvent.change(screen.getByLabelText('Code 1'), { target: { value: 'smp001a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add charge' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const body = JSON.parse(fetchMock.mock.calls.find((c) => c[0] === '/api/billing/charge-lines')![1].body)
    expect(body.procedureCodes).toEqual([{ kind: 'hbp', code: 'smp001a' }])
  })
})
