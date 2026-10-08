import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { PreauthForm } from '@/components/rcm/PreauthForm'
import { PreauthActions } from '@/components/rcm/PreauthActions'

afterEach(() => vi.unstubAllGlobals())

const PROPS = { policies: [{ id: 2, label: 'Star · POL/1 (primary)' }], admissions: [], encounters: [], doctors: [{ id: 4, name: 'Dr X' }] }

describe('PreauthForm', () => {
  it('shows the live estimate with price sources and an unpriced service message', async () => {
    let unpriced = false
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/tariff/services')) return new Response(JSON.stringify({ services: [{ id: 7, code: 'SVC7', name: 'Appendicectomy' }, { id: 9, code: 'SVC9', name: 'Unpriced' }] }))
      if (url === '/api/rcm/preauths/estimate') {
        return unpriced
          ? new Response(JSON.stringify({ error: 'No tariff rate covers SVC9' }), { status: 422 })
          : new Response(JSON.stringify({ lines: [{ serviceId: 7, code: 'SVC7', name: 'Appendicectomy', quantity: 1, unitPricePaise: 50_000_00, amountPaise: 50_000_00, priceSource: 'payer' }], totalPaise: 50_000_00 }))
      }
      return new Response('{}', { status: 404 })
    }))
    render(<PreauthForm {...PROPS} />)
    fireEvent.change(screen.getByLabelText('Planned admission date'), { target: { value: '2026-10-01' } })
    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'app' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'SVC7 · Appendicectomy' }))
    expect(await screen.findByText('Payer rate', {}, { timeout: 2000 })).toBeInTheDocument()
    expect(screen.getByText('Estimate ₹50,000.00')).toBeInTheDocument()
    unpriced = true
    fireEvent.change(screen.getByLabelText('Search services'), { target: { value: 'unp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'SVC9 · Unpriced' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No tariff rate covers SVC9'), { timeout: 2000 })
  })
})

describe('PreauthActions', () => {
  it('offers only the allowed actions for the status', () => {
    render(<PreauthActions preauthId={1} status="approved" enhancedBefore={false} openQueryId={null} rejectionReasons={[]} />)
    expect(screen.getByText('Request enhancement', { selector: 'summary' })).toBeInTheDocument()
    expect(screen.getByText('Cancel', { selector: 'summary' })).toBeInTheDocument()
    expect(screen.queryByText('Record approval', { selector: 'summary' })).not.toBeInTheDocument()
    expect(screen.getAllByText(/./, { selector: 'summary' }).map((s) => s.textContent)).toEqual(['Request enhancement', 'Cancel'])
  })
})
