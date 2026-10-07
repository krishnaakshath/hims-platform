import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { ServiceFormModal } from '@/components/tariff/ServiceFormModal'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const departments = [{ id: 1, code: 'GEN', name: 'General Medicine' }, { id: 2, code: 'LAB', name: 'Laboratory' }]

function fill(values: Record<string, string>) {
  for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('ServiceFormModal', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    refresh.mockClear()
    fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('flags a SAC/HSN mismatch for a consumable before submitting', async () => {
    render(<ServiceFormModal mode="create" departments={departments} onClose={vi.fn()} />)
    fill({ Code: 'GLOVE1', Name: 'Gloves', Department: '1', Category: 'consumable', 'HSN/SAC': '999311', 'GST rate': '1200' })
    fireEvent.click(screen.getByRole('button', { name: 'Create service' }))
    expect(await screen.findByText(/need an HSN code, not a SAC/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs a valid new service with GST in basis points', async () => {
    const onClose = vi.fn()
    render(<ServiceFormModal mode="create" departments={departments} onClose={onClose} />)
    fill({ Code: 'cons1', Name: 'OPD Consultation', Department: '1', Category: 'consultation', 'HSN/SAC': '999311', 'GST rate': '1800' })
    fireEvent.click(screen.getByRole('button', { name: 'Create service' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/tariff/services')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ code: 'CONS1', name: 'OPD Consultation', departmentId: 1, category: 'consultation', hsnSac: '999311', gstRateBp: 1800, requiresPreauth: false, maxQuantity: null })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(refresh).toHaveBeenCalled()
  })

  it('labels GST options as percent', () => {
    render(<ServiceFormModal mode="create" departments={departments} onClose={vi.fn()} />)
    expect(screen.getByRole('option', { name: '18%' })).toHaveValue('1800')
    expect(screen.getByRole('option', { name: '40%' })).toHaveValue('4000')
  })

  it('shows the server error inline (409 duplicate code)', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'A service with this code already exists' }), { status: 409 }))
    render(<ServiceFormModal mode="create" departments={departments} onClose={vi.fn()} />)
    fill({ Code: 'CONS1', Name: 'OPD', Department: '1', Category: 'consultation', 'HSN/SAC': '999311', 'GST rate': '0' })
    fireEvent.click(screen.getByRole('button', { name: 'Create service' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A service with this code already exists')
  })

  it('keeps the code read-only in edit mode and PATCHes without a code', async () => {
    const service = { id: 11, code: 'CONS1', name: 'OPD', departmentId: 1, category: 'consultation' as const, hsnSac: '999311', gstRateBp: 0 }
    render(<ServiceFormModal mode="edit" service={service} departments={departments} onClose={vi.fn()} />)
    const code = screen.getByLabelText('Code')
    expect(code).toHaveAttribute('readonly')
    expect(code).toHaveValue('CONS1')
    fill({ Name: 'OPD Consultation (new)' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/tariff/services/11')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body)).not.toHaveProperty('code')
    expect(JSON.parse(init.body).name).toBe('OPD Consultation (new)')
  })

  // SP4 billing flags.
  it('sends the pre-authorisation flag and a max quantity, and refuses a bad quantity', async () => {
    const service = { id: 11, code: 'PROC1', name: 'Dressing', departmentId: 1, category: 'procedure' as const, hsnSac: '999311', gstRateBp: 0, requiresPreauth: false, maxQuantity: null }
    render(<ServiceFormModal mode="edit" service={service} departments={departments} onClose={vi.fn()} />)
    fill({ 'Max quantity per line': '0' })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Max quantity must be a whole number from 1 to 1000')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
    fill({ 'Max quantity per line': '4' })
    fireEvent.click(screen.getByLabelText('Needs pre-authorisation'))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ requiresPreauth: true, maxQuantity: 4 })
  })
})
