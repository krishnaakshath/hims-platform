import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LabServiceAreaPanel } from '@/components/settings/LabServiceAreaPanel'
import { HomeCollectionWindowsPanel } from '@/components/settings/HomeCollectionWindowsPanel'
import { LabTestSetupPanel } from '@/components/settings/LabTestSetupPanel'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const pin = (o: object) => ({ id: 1, pinCode: '560001', areaLabel: 'Indiranagar', isActive: true, createdByName: 'x', createdAt: new Date(), updatedAt: new Date(), ...o }) as never
const win = (o: object) => ({ id: 1, label: 'Morning', startTime: '07:00', endTime: '09:00', capacity: 10, isActive: true, sortOrder: 0, createdAt: new Date(), updatedAt: new Date(), ...o }) as never
const test = { id: 5, name: 'Complete blood count', code: '58410-2', category: 'lab' as const, sampleType: null, container: null, serviceId: null, serviceCode: null, serviceName: null }

afterEach(() => vi.unstubAllGlobals())

describe('LabServiceAreaPanel', () => {
  it('is read-only for non-admin', () => {
    render(<LabServiceAreaPanel pins={[pin({})]} isAdmin={false} />)
    expect(screen.getByText('560001')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('lets an admin paste PINs and names the invalid ones from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Some PIN codes are not valid', invalid: ['12345'] }), { status: 400 })))
    render(<LabServiceAreaPanel pins={[]} isAdmin />)
    expect(screen.getByText(/no pin codes yet/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('PIN codes'), { target: { value: '560001, 12345' } })
    fireEvent.click(screen.getByRole('button', { name: /add pin codes/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Some PIN codes are not valid: 12345'))
  })

  it('shows an inactive PIN with a badge and an Activate action', () => {
    render(<LabServiceAreaPanel pins={[pin({ isActive: false })]} isAdmin />)
    expect(screen.getByText('Inactive')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /activate 560001/i })).toBeInTheDocument()
  })
})

describe('HomeCollectionWindowsPanel', () => {
  it('is read-only for non-admin', () => {
    render(<HomeCollectionWindowsPanel windows={[win({})]} isAdmin={false} />)
    expect(screen.getByText('Morning')).toBeInTheDocument()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the overlap message from the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This window overlaps another active window' }), { status: 409 })))
    render(<HomeCollectionWindowsPanel windows={[]} isAdmin />)
    fireEvent.change(screen.getByLabelText('Window label'), { target: { value: 'Early' } })
    fireEvent.click(screen.getByRole('button', { name: /add window/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This window overlaps another active window'))
  })

  // Fix wave (shared client fetch helper): a network failure is shown, not an unhandled rejection.
  it('shows a network failure in an alert and re-enables the button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    render(<HomeCollectionWindowsPanel windows={[]} isAdmin />)
    fireEvent.change(screen.getByLabelText('Window label'), { target: { value: 'Early' } })
    fireEvent.click(screen.getByRole('button', { name: /add window/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server. Check your connection and try again.'))
    expect(screen.getByRole('button', { name: /add window/i })).toBeEnabled()
  })
})

describe('LabTestSetupPanel', () => {
  it('is read-only for non-admin', () => {
    render(<LabTestSetupPanel tests={[test]} services={[]} isAdmin={false} />)
    expect(screen.getByText('Complete blood count')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('lets an admin pick a sample type', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<LabTestSetupPanel tests={[test]} services={[{ id: 3, code: 'LAB_CBC', name: 'CBC' }]} isAdmin />)
    fireEvent.change(screen.getByLabelText('Sample type for Complete blood count'), { target: { value: 'blood' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/lab-tests/5', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ sampleType: 'blood' }) })))
  })
})
