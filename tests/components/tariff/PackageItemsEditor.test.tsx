import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { PackageItemsEditor } from '@/components/tariff/PackageItemsEditor'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const services = [
  { id: 10, code: 'PKG1', name: 'Delivery Package', category: 'package' as const },
  { id: 11, code: 'CONS1', name: 'OPD Consultation', category: 'consultation' as const },
  { id: 12, code: 'LAB1', name: 'CBC', category: 'investigation_lab' as const },
  { id: 13, code: 'PKG2', name: 'Other Package', category: 'package' as const },
]

describe('PackageItemsEditor', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs items with quantities', async () => {
    render(<PackageItemsEditor packageServiceId={10} items={[{ itemServiceId: 11, code: 'CONS1', name: 'OPD Consultation', quantity: 1 }]} services={services} />)
    fireEvent.change(screen.getByLabelText('Quantity of CONS1'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Search services to add'), { target: { value: 'cbc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add LAB1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save package items' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tariff/packages/10/items')
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ items: [{ serviceId: 11, quantity: 3 }, { serviceId: 12, quantity: 1 }] })
  })

  it('blocks adding the package to itself and nested packages', () => {
    render(<PackageItemsEditor packageServiceId={10} items={[]} services={services} />)
    fireEvent.change(screen.getByLabelText('Search services to add'), { target: { value: 'PKG' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add PKG1' }))
    expect(screen.getByRole('alert')).toHaveTextContent('A package cannot include itself')
    fireEvent.click(screen.getByRole('button', { name: 'Add PKG2' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/cannot be nested/i)
    fireEvent.click(screen.getByRole('button', { name: 'Save package items' }))
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes('packages') || JSON.parse(c[1].body).items.length === 0)).toBe(true)
  })

  it('rejects a zero or fractional quantity client-side', async () => {
    render(<PackageItemsEditor packageServiceId={10} items={[{ itemServiceId: 11, code: 'CONS1', name: 'OPD Consultation', quantity: 1 }]} services={services} />)
    fireEvent.change(screen.getByLabelText('Quantity of CONS1'), { target: { value: '1.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save package items' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole number/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the server error and an empty state', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'CONS1 is inactive' }), { status: 400 }))
    render(<PackageItemsEditor packageServiceId={10} items={[{ itemServiceId: 11, code: 'CONS1', name: 'OPD Consultation', quantity: 1 }]} services={services} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save package items' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('CONS1 is inactive')
  })

  it('shows an empty state when the package has no items', () => {
    render(<PackageItemsEditor packageServiceId={10} items={[]} services={services} />)
    expect(screen.getByText(/no items yet/i)).toBeInTheDocument()
  })
})
