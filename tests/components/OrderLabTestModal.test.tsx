import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { OrderLabTestModal, type LabTestOption } from '@/components/OrderLabTestModal'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockClear() })

const TESTS: LabTestOption[] = [
  { id: 1, name: 'Complete Blood Count', code: 'CBC', defaultUnit: null, referenceRange: null, category: 'lab' },
  { id: 2, name: 'Chest X-Ray, 2 Views', code: 'XR-CHEST-2V', defaultUnit: null, referenceRange: null, category: 'imaging' },
  { id: 3, name: 'Lipid Panel', code: 'LIPID', defaultUnit: null, referenceRange: null, category: 'lab' },
]

const created = (patientIsLocal: boolean) =>
  vi.fn(async () => new Response(JSON.stringify({ requisitionId: 12, lines: [], patientIsLocal, notification: null }), { status: 201 }))

describe('OrderLabTestModal', () => {
  it('posts the checked tests and the follow-up request', async () => {
    const fetchMock = created(true)
    vi.stubGlobal('fetch', fetchMock)
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    const submit = screen.getByRole('button', { name: /order 0 tests|order tests/i })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lipid panel/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /ask for a follow-up visit after the report/i }))
    fireEvent.change(screen.getByLabelText(/^follow-up after$/i), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText(/^unit$/i), { target: { value: 'weeks' } })
    fireEvent.change(screen.getByLabelText(/^reason/i), { target: { value: 'Review' } })
    fireEvent.click(screen.getByRole('button', { name: /order 2 tests/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/patients/RD-0001/lab-orders')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ labTestIds: [1, 3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review' } })
  })

  it('sends followUp null when no follow-up is asked for, and says home collection is available', async () => {
    const fetchMock = created(true)
    vi.stubGlobal('fetch', fetchMock)
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ labTestIds: [1], followUp: null })
    expect(await screen.findByText('Home collection available for this patient')).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it('tells staff when the patient is outside the home-collection area', async () => {
    vi.stubGlobal('fetch', created(false))
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /lipid panel/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByText('Patient is outside the home-collection area: walk-in only')).toBeInTheDocument()
  })

  it('does not offer home collection for an imaging-only order, even for a local patient', async () => {
    vi.stubGlobal('fetch', created(true))
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /chest x-ray/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByText('Tests ordered.')).toBeInTheDocument()
    expect(screen.queryByText('Home collection available for this patient')).not.toBeInTheDocument()
    expect(screen.queryByText(/walk-in only/)).not.toBeInTheDocument()
  })

  it('refuses a follow-up without a reason before posting', async () => {
    const fetchMock = created(true)
    vi.stubGlobal('fetch', fetchMock)
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /ask for a follow-up visit after the report/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/reason/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the server error and stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Lab test not found' }), { status: 404 })))
    const onClose = vi.fn()
    render(<OrderLabTestModal patientId="RD-0001" labTests={TESTS} onClose={onClose} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /complete blood count/i }))
    fireEvent.click(screen.getByRole('button', { name: /order 1 test/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Lab test not found')
    expect(onClose).not.toHaveBeenCalled()
  })
})
