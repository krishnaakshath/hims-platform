import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AddRateModal } from '@/components/tariff/AddRateModal'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const base = {
  serviceId: 5, serviceCategory: 'consultation' as const, today: '2026-10-07',
  departments: [{ id: 1, code: 'GEN', name: 'General Medicine' }],
  payers: [{ id: 3, name: 'Star Health' }],
  roomCategories: [{ id: 2, code: 'ICU', name: 'Intensive Care' }],
}

function open(props = base) {
  render(<AddRateModal {...props} />)
  fireEvent.click(screen.getByRole('button', { name: 'Add rate' }))
}

describe('AddRateModal', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('converts ₹1,250.50 to amountPaise 125050 and shows the payer select only for payer scope', async () => {
    open()
    expect(screen.queryByLabelText('Payer')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Department')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'payer' } })
    expect(screen.getByLabelText('Payer')).toBeInTheDocument()
    expect(screen.queryByLabelText('Department')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Payer'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '₹1,250.50' } })
    expect(screen.getByLabelText('Valid from')).toHaveValue('2026-10-07')
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tariff/rates')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ serviceId: 5, scope: 'payer', payerId: 3, amountPaise: 125050, validFrom: '2026-10-07' })
  })

  it('shows the department select for department scope and sends room category and ward', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'department' } })
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '1' } })
    fireEvent.change(screen.getByLabelText('Room category (optional)'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Ward (optional)'), { target: { value: 'ICU Ward' } })
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '800' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ scope: 'department', departmentId: 1, roomCategoryId: 2, ward: 'ICU Ward', amountPaise: 80000 })
  })

  it('labels room and ward "per day" for room rent services', () => {
    open({ ...base, serviceCategory: 'room_rent' as never })
    expect(screen.getByLabelText('Room category (per day, optional)')).toBeInTheDocument()
    expect(screen.getByLabelText('Ward (per day, optional)')).toBeInTheDocument()
  })

  it('shows the server overlap message on 409', async () => {
    const msg = 'This rate overlaps an existing rate for the same service, scope and room/ward'
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: msg }), { status: 409 }))
    open()
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(msg)
  })

  it('blocks an invalid amount and a missing payer without calling the API', async () => {
    open()
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    expect(await screen.findByText(/valid amount/i)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'payer' } })
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save rate' }))
    expect(await screen.findByText(/choose a payer/i)).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
