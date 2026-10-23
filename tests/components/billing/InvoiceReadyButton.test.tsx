import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { InvoiceReadyButton } from '@/components/billing/InvoiceReadyButton'

// WS2 T12: preview, then create drafts; patient scope on the cash desk.
const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

let fetchMock: ReturnType<typeof vi.fn>
let preview = { groups: 2, lines: 3, taxablePaise: 98000, waitingLines: 1 }
beforeEach(() => {
  refresh.mockClear()
  preview = { groups: 2, lines: 3, taxablePaise: 98000, waitingLines: 1 }
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ created: [{ invoiceId: 7, patientId: 'RD-1', lineCount: 2 }], skipped: [{ patientId: 'RD-2', error: 'lines_not_available' }] }), { status: 200 })
    }
    return new Response(JSON.stringify(preview), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('InvoiceReadyButton', () => {
  it('previews, then creates the drafts and refreshes', async () => {
    render(<InvoiceReadyButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Invoice all ready lines' }))
    expect(await screen.findByText('3 lines ready (₹980.00 before tax) will go on 2 draft invoices.')).toBeInTheDocument()
    expect(screen.getByText('1 line waiting for the visit/stay to close.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/invoice-ready')
    fireEvent.click(screen.getByRole('button', { name: 'Create draft invoices' }))
    expect(await screen.findByText('Created 1 draft invoice for 2 lines. 1 group changed meanwhile and was skipped; check again.')).toBeInTheDocument()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({})
    expect(refresh).toHaveBeenCalled()
  })

  it('scopes to one patient and says when nothing is ready', async () => {
    preview = { groups: 0, lines: 0, taxablePaise: 0, waitingLines: 0 }
    render(<InvoiceReadyButton patientId="RD-1" label="Invoice ready charges" />)
    fireEvent.click(screen.getByRole('button', { name: 'Invoice ready charges' }))
    expect(await screen.findByText('No lines are ready to invoice.')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith('/api/billing/invoice-ready?patientId=RD-1')
    expect(screen.queryByRole('button', { name: 'Create draft invoices' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Invoice ready charges' })).toBeInTheDocument())
  })
})
