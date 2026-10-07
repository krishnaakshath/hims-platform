import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { Role } from '@/lib/auth'

let role: Role = 'crc'
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'T', userId: null })) }))
const redirect = vi.fn((path: string) => { throw new Error(`REDIRECT ${path}`) })
vi.mock('next/navigation', () => ({
  redirect: (p: string) => redirect(p),
  notFound: () => { throw new Error('NOT_FOUND') },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/invoices', () => ({ listInvoices: vi.fn(), getInvoice: vi.fn(), INVOICE_PAGE_SIZE: 50 }))
vi.mock('@/components/billing/InvoiceDocument', () => ({ InvoiceDocument: vi.fn(() => <div data-testid="doc" />) }))
vi.mock('@/components/billing/InvoiceActions', () => ({ InvoiceActions: vi.fn(() => <div data-testid="actions" />) }))

import { getInvoice, listInvoices } from '@/lib/queries/invoices'
import { InvoiceActions } from '@/components/billing/InvoiceActions'
import { logAudit } from '@/lib/audit'
import InvoicesPage from '@/app/(dashboard)/billing/invoices/page'
import InvoicePage from '@/app/(dashboard)/billing/invoices/[id]/page'
import PrintInvoicePage from '@/app/print/invoices/[id]/page'

const ROW = { id: 7, invoiceNumber: 'INV/99-00/000001', status: 'finalised', patientId: 'RD-1', patientName: 'Asha Rao', uhid: 'HMS-000123', payerName: 'Star Health', invoiceDate: '2099-06-01', totalPaise: 3_540_000_000, createdAt: new Date() }
const DETAIL = { id: 7, status: 'finalised', patientId: 'RD-1', invoiceNumber: 'INV/99-00/000001' }

beforeEach(() => {
  role = 'crc'
  vi.clearAllMocks()
  vi.mocked(listInvoices).mockResolvedValue({ rows: [ROW as never, { ...ROW, id: 8, invoiceNumber: null, status: 'draft', invoiceDate: null, totalPaise: null, payerName: null } as never], total: 120 })
  vi.mocked(getInvoice).mockResolvedValue(DETAIL as never)
})

describe('/billing/invoices', () => {
  it('lists invoices with number or Draft #id, totals in INR and the range shown', async () => {
    render(await InvoicesPage({ searchParams: Promise.resolve({ status: 'finalised', q: 'INV', page: '2' }) }))
    expect(listInvoices).toHaveBeenCalledWith({ status: 'finalised', q: 'INV', page: 2 })
    expect(screen.getByRole('link', { name: 'INV/99-00/000001' })).toHaveAttribute('href', '/billing/invoices/7')
    expect(screen.getByRole('link', { name: 'Draft #8' })).toHaveAttribute('href', '/billing/invoices/8')
    expect(screen.getByText('₹3,54,00,000.00')).toBeInTheDocument()
    expect(screen.getByText('Showing 51–100 of 120')).toBeInTheDocument()
    expect(screen.getByText('Star Health')).toBeInTheDocument()
  })

  it('ignores an unknown status and a bad page', async () => {
    render(await InvoicesPage({ searchParams: Promise.resolve({ status: 'nope', page: 'x' }) }))
    expect(listInvoices).toHaveBeenCalledWith({ status: undefined, q: undefined, page: 1 })
  })

  it('redirects a denied role before loading anything', async () => {
    role = 'frontdesk'
    await expect(InvoicesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT /')
    expect(listInvoices).not.toHaveBeenCalled()
  })
})

describe('/billing/invoices/[id] and /print/invoices/[id]', () => {
  it('shows the document and actions; authority depends on the role; audited', async () => {
    render(await InvoicePage({ params: Promise.resolve({ id: '7' }) }))
    expect(vi.mocked(InvoiceActions).mock.calls[0][0]).toMatchObject({ invoiceId: 7, status: 'finalised', canAuthorise: false })
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'billing: viewed invoice', 'RD-1')
    role = 'billing'
    render(await InvoicePage({ params: Promise.resolve({ id: '7' }) }))
    expect(vi.mocked(InvoiceActions).mock.calls[1][0]).toMatchObject({ canAuthorise: true })
  })

  it('404s a bad or unknown id', async () => {
    await expect(InvoicePage({ params: Promise.resolve({ id: 'x' }) })).rejects.toThrow('NOT_FOUND')
    vi.mocked(getInvoice).mockResolvedValue(null)
    await expect(InvoicePage({ params: Promise.resolve({ id: '9' }) })).rejects.toThrow('NOT_FOUND')
    await expect(PrintInvoicePage({ params: Promise.resolve({ id: '9' }) })).rejects.toThrow('NOT_FOUND')
  })

  it('the print view is audited and has print and back controls hidden on paper', async () => {
    const { container } = render(await PrintInvoicePage({ params: Promise.resolve({ id: '7' }) }))
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'billing: printed invoice', 'RD-1')
    expect(screen.getByRole('button', { name: 'Print' }).closest('.print\\:hidden')).not.toBeNull()
    expect(container.querySelector('[data-testid="doc"]')).not.toBeNull()
  })

  it('the print view redirects a denied role first', async () => {
    role = 'pharmacy'
    await expect(PrintInvoicePage({ params: Promise.resolve({ id: '7' }) })).rejects.toThrow('REDIRECT /')
    expect(getInvoice).not.toHaveBeenCalled()
  })
})
