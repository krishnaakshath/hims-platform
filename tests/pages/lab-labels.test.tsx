// SP5 Task 9: the printable sample label sheet (/lab-labels), with the query and audit mocked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

let role = 'labs'
vi.mock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }) }))
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'TEST_SP5 labels', userId: null })) }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('@/lib/queries/lab-orders', () => ({ listLabelsForOrders: vi.fn() }))

import Page from '@/app/(dashboard)/lab-labels/page'
import { listLabelsForOrders } from '@/lib/queries/lab-orders'
import { logAudit } from '@/lib/audit'
import { redirect } from 'next/navigation'

const props = (orders?: string) => ({ searchParams: Promise.resolve(orders === undefined ? {} : { orders }) })
const LABEL = { orderId: 1, sampleId: 'L26100800429', testName: 'Glucose, fasting', container: 'fluoride_grey', patientName: 'Asha Rao', uhid: 'UH-000042' }

beforeEach(() => {
  role = 'labs'
  vi.mocked(listLabelsForOrders).mockReset().mockResolvedValue([LABEL])
  vi.mocked(logAudit).mockClear()
})
afterEach(() => cleanup())

describe('/lab-labels', () => {
  it('renders a QR and the grouped sample ID and audits ids only', async () => {
    const { container } = render(await Page(props('1')))
    const svg = container.querySelector('svg[data-testid="sample-qr"]')
    expect(svg).not.toBeNull()
    expect(svg!.querySelectorAll('rect').length).toBeGreaterThan(0)
    expect(screen.getByText('L261008-0042-9')).toBeInTheDocument()
    expect(screen.getByText('Glucose, fasting')).toBeInTheDocument()
    expect(screen.getByText('Fluoride (grey cap)')).toBeInTheDocument()
    expect(screen.getByText(/Asha Rao/)).toBeInTheDocument()
    expect(screen.getByText(/UH-000042/)).toBeInTheDocument()
    expect(container.innerHTML).toContain('@media print')
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'labs' }), 'printed lab sample labels', null, 'orders=1')
  })

  it('drops invalid ids from the orders param', async () => {
    await Page(props('x,-1,2'))
    expect(listLabelsForOrders).toHaveBeenCalledWith([2])
  })

  it('caps the list at 50 ids and de-duplicates', async () => {
    const many = Array.from({ length: 60 }, (_, i) => String(i + 1)).join(',')
    await Page(props(`${many},1`))
    expect(vi.mocked(listLabelsForOrders).mock.calls[0][0]).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })

  it('no valid order -> "No orders selected." and no query or audit', async () => {
    render(await Page(props('abc')))
    expect(screen.getByText('No orders selected.')).toBeInTheDocument()
    expect(listLabelsForOrders).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('an order without a sample ID shows "No sample ID yet" and no QR', async () => {
    vi.mocked(listLabelsForOrders).mockResolvedValue([{ ...LABEL, sampleId: null }])
    const { container } = render(await Page(props('1')))
    expect(screen.getByText('No sample ID yet')).toBeInTheDocument()
    expect(container.querySelector('svg[data-testid="sample-qr"]')).toBeNull()
  })

  it.each(['crc', 'collector', 'billing'])('redirects %s before any query', async (r) => {
    role = r
    await expect(Page(props('1'))).rejects.toThrow('NEXT_REDIRECT')
    expect(redirect).toHaveBeenCalledWith('/')
    expect(listLabelsForOrders).not.toHaveBeenCalled()
  })
})
