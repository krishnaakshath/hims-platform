import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { ReceiveStockDialog } from '@/components/pharmacy/ReceiveStockDialog'
import { ToastProvider } from '@/components/ui/toast'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
afterEach(() => { vi.unstubAllGlobals(); refresh.mockReset() })

const MEDS = [{ id: 3, name: 'Paracetamol 500 mg' }, { id: 7, name: 'Amoxicillin 250 mg' }]

// Closing unmounts the dialog, as on the dashboard, so the toast outside the modal is reachable.
function Harness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(true)
  return open ? <ReceiveStockDialog medications={MEDS} onClose={() => { onClose(); setOpen(false) }} /> : null
}

function setup(onClose = vi.fn()) {
  render(<ToastProvider><Harness onClose={onClose} /></ToastProvider>)
  return onClose
}

function fillLine(n: number, v: { med: string; batch: string; expiry: string; qty: string; mrp: string; rate: string }) {
  fireEvent.change(screen.getByLabelText(`Medication, line ${n}`), { target: { value: v.med } })
  fireEvent.change(screen.getByLabelText(`Batch number, line ${n}`), { target: { value: v.batch } })
  fireEvent.change(screen.getByLabelText(`Expiry date, line ${n}`), { target: { value: v.expiry } })
  fireEvent.change(screen.getByLabelText(`Quantity, line ${n}`), { target: { value: v.qty } })
  fireEvent.change(screen.getByLabelText(`MRP per unit (₹), line ${n}`), { target: { value: v.mrp } })
  fireEvent.change(screen.getByLabelText(`Purchase rate per unit (₹), line ${n}`), { target: { value: v.rate } })
}

describe('ReceiveStockDialog', () => {
  it('adds and removes lines and shows the running total in ₹', () => {
    setup()
    expect(screen.getAllByLabelText(/^Batch number, line/)).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Add line' }))
    expect(screen.getAllByLabelText(/^Batch number, line/)).toHaveLength(2)
    fillLine(1, { med: '3', batch: 'PCM-1', expiry: '2099-12-31', qty: '100', mrp: '2.50', rate: '1.80' })
    fillLine(2, { med: '7', batch: 'AMX-1', expiry: '2099-12-31', qty: '10', mrp: '12', rate: '1,000.50' })
    // 100 × ₹1.80 + 10 × ₹1,000.50
    expect(screen.getByText('Total ₹10,185.00')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }))
    expect(screen.getAllByLabelText(/^Batch number, line/)).toHaveLength(1)
    expect(screen.getByText('Total ₹180.00')).toBeInTheDocument()
  })

  it('posts the GRN in paise and shows a success toast with a link to the stock view', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ grnId: 1, grnNumber: 'GRN/26-27/000001' }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const onClose = setup()
    fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: 'Sri Venkateswara Pharma' } })
    fireEvent.change(screen.getByLabelText('Supplier invoice number'), { target: { value: 'SV/1234' } })
    fireEvent.change(screen.getByLabelText('Supplier invoice date'), { target: { value: '2026-10-20' } })
    fillLine(1, { med: '3', batch: 'PCM-1', expiry: '2099-12-31', qty: '100', mrp: '2.50', rate: '1.80' })
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))

    expect(await screen.findByText('GRN/26-27/000001 received')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View stock' })).toHaveAttribute('href', '/pharmacy')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pharmacy/grns')
    expect(JSON.parse(init!.body as string)).toEqual({
      supplierName: 'Sri Venkateswara Pharma',
      supplierInvoiceNo: 'SV/1234',
      supplierInvoiceDate: '2026-10-20',
      lines: [{ medicationId: 3, batchNo: 'PCM-1', expiryDate: '2099-12-31', quantity: 100, mrpPerUnitPaise: 250, purchaseRatePaise: 180 }],
    })
    expect(onClose).toHaveBeenCalled()
    expect(refresh).toHaveBeenCalled()
  })

  it('shows the server refusal and stays open', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Batch PCM-1 is already on file with a different expiry or MRP.', code: 'batch_conflict' }), { status: 409 })))
    const onClose = setup()
    fireEvent.change(screen.getByLabelText('Supplier name'), { target: { value: 'Sri Venkateswara Pharma' } })
    fireEvent.change(screen.getByLabelText('Supplier invoice number'), { target: { value: 'SV/1234' } })
    fillLine(1, { med: '3', batch: 'PCM-1', expiry: '2099-12-31', qty: '100', mrp: '2.50', rate: '1.80' })
    fireEvent.click(screen.getByRole('button', { name: 'Receive stock' }))
    expect(await screen.findByText(/already on file with a different expiry or MRP/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
})
