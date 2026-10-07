import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { ServicesTable, type ServiceListItem } from '@/components/tariff/ServicesTable'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

const departments = [{ id: 1, code: 'GEN', name: 'General Medicine' }, { id: 2, code: 'LAB', name: 'Laboratory' }]
const svc = (over: Partial<ServiceListItem> = {}): ServiceListItem => ({
  id: 11, code: 'CONS1', name: 'OPD Consultation', departmentId: 1, departmentName: 'General Medicine',
  category: 'consultation', hsnSac: '999311', gstRateBp: 0, isActive: true, basePaise: 50000, departmentPaise: null, ...over,
})

describe('ServicesTable', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    refresh.mockClear()
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows base and department prices in INR and a dash when missing', () => {
    render(<ServicesTable services={[svc({ basePaise: 50000, departmentPaise: null }), svc({ id: 12, code: 'X2', basePaise: 12345678, departmentPaise: 99900 })]} departments={departments} filters={{}} />)
    expect(screen.getByText('₹500.00')).toBeInTheDocument()
    expect(screen.getByText('₹1,23,456.78')).toBeInTheDocument()
    expect(screen.getByText('₹999.00')).toBeInTheDocument()
    const row = screen.getByText('CONS1').closest('tr')!
    expect(within(row).getByText('—')).toBeInTheDocument()
  })

  it('links each row to its detail page', () => {
    render(<ServicesTable services={[svc()]} departments={departments} filters={{}} />)
    expect(screen.getByRole('link', { name: 'OPD Consultation' })).toHaveAttribute('href', '/tariffs/services/11')
    expect(screen.getByRole('link', { name: /room categories/i })).toHaveAttribute('href', '/tariffs/room-categories')
    expect(screen.getByRole('link', { name: /import/i })).toHaveAttribute('href', '/tariffs/import')
  })

  it('shows an empty state', () => {
    render(<ServicesTable services={[]} departments={departments} filters={{}} />)
    expect(screen.getByText(/no services match/i)).toBeInTheDocument()
  })

  it('asks for confirmation before deactivating and PATCHes isActive false', async () => {
    render(<ServicesTable services={[svc()]} departments={departments} filters={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate CONS1' }))
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate service' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/tariff/services/11')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).toEqual({ isActive: false })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
  })

  it('surfaces the server error when deactivating fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Service not found' }), { status: 404 }))
    render(<ServicesTable services={[svc()]} departments={departments} filters={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate CONS1' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate service' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Service not found')
  })

  it('opens the create and edit modals', async () => {
    render(<ServicesTable services={[svc()]} departments={departments} filters={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'New service' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Edit CONS1' }))
    expect(await screen.findByLabelText('Code')).toHaveAttribute('readonly')
  })

  it('renders imported text as text, never markup', () => {
    render(<ServicesTable services={[svc({ name: '<img src=x onerror=alert(1)>' })]} departments={departments} filters={{}} />)
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
  })
})
