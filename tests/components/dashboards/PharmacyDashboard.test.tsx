import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { deadLinks } from '../../pages/dashboard-link-gates'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/pharmacy' }))
vi.mock('@/components/DispenseMedicationModal', () => ({ DispenseMedicationModal: () => null }))
vi.mock('@/components/AddMedicationModal', () => ({ AddMedicationModal: () => null }))

import { PharmacyDashboard } from '@/components/dashboards/PharmacyDashboard'

// Wave E P1-18: the pharmacy home is no longer a dead end.
const med = (id: number, name: string, quantityOnHand: number, reorderThreshold = 5) => ({ id, name, genericName: null, medicationClass: 'Test', commonDose: null, form: 'tablet' as const, quantityOnHand, reorderThreshold, unit: 'tabs', mrpPerUnitPaise: null, gstRateBp: null, hsn: null, effectiveGstRateBp: 500 /* WS2 T8 */ })
const MEDS = [med(1, 'Paracetamol 500', 0), med(2, 'Amoxicillin 250', 3), med(3, 'Metformin 500', 100)]
const KPIS = { outOfStock: 1, lowStock: 1, dispensedToday: 7, unbilledDispenses: 4 }
const props = (role: 'pharmacy' | 'admin' | 'pi' | 'crc', stockFilter: 'out' | 'low' | null = null) => ({
  session: { role, name: 'T', userId: null },
  medications: MEDS,
  canDispense: role !== 'crc',
  prescribedSummary: [{ name: 'Metformin 500', medicationClass: 'Test', activeEpisodeCount: 2, inCatalog: true }],
  canAddMedication: role === 'pharmacy' || role === 'admin',
  kpis: KPIS,
  stockFilter,
  canUseCounter: role === 'pharmacy' || role === 'admin',
})
const tile = (c: HTMLElement, label: string) => {
  const el = [...c.querySelectorAll('[data-kpi-label]')].find((e) => e.textContent === label)
  return { value: el?.previousElementSibling?.textContent, href: el?.closest('a')?.getAttribute('href') }
}

describe('PharmacyDashboard (Wave E P1-18)', () => {
  it('stock tiles filter the stock table; counter tiles open dispensing billing', () => {
    const { container } = render(<PharmacyDashboard {...props('pharmacy')} />)
    expect(tile(container, 'Out of Stock')).toEqual({ value: '1', href: '/pharmacy?stock=out' })
    expect(tile(container, 'Low Stock')).toEqual({ value: '1', href: '/pharmacy?stock=low' })
    expect(tile(container, 'Dispensed today')).toEqual({ value: '7', href: '/pharmacy/billing' })
    expect(tile(container, 'Awaiting billing')).toEqual({ value: '4', href: '/pharmacy/billing' })
    expect(container.querySelector('a[href="/pharmacy/patient-lookup"]')).not.toBeNull()
  })

  it('?stock=out lists only out-of-stock medications, with a way back', () => {
    render(<PharmacyDashboard {...props('pharmacy', 'out')} />)
    expect(screen.getByText('Paracetamol 500')).toBeInTheDocument()
    expect(screen.queryByText('Amoxicillin 250')).toBeNull()
    expect(screen.getByRole('link', { name: /show all stock/i })).toHaveAttribute('href', '/pharmacy')
  })

  it('the counter roles dispense through the patient lookup (against a prescription), not a free-typed id', () => {
    render(<PharmacyDashboard {...props('pharmacy')} />)
    const dispense = screen.getAllByRole('link', { name: 'Dispense' })
    expect(dispense.length).toBe(3)
    for (const a of dispense) expect(a).toHaveAttribute('href', '/pharmacy/patient-lookup')
  })

  it('crc and pi (no counter) see no counter tiles or lookup links', () => {
    for (const role of ['crc', 'pi'] as const) {
      const { container, unmount } = render(<PharmacyDashboard {...props(role)} />)
      expect(container.querySelector('a[href^="/pharmacy/"]')).toBeNull()
      expect(deadLinks(container, role)).toEqual([])
      unmount()
    }
  })

  it.each(['pharmacy', 'admin'] as const)('no dead links for %s', (role) => {
    const { container } = render(<PharmacyDashboard {...props(role)} />)
    expect(deadLinks(container, role)).toEqual([])
  })

  // WS2 T8: the MRP column, editable by the pricing roles only.
  it('shows each MRP; a pricing role edits it through the price route', async () => {
    const priced = [{ ...med(1, 'Paracetamol 500', 50), mrpPerUnitPaise: 350 }, med(2, 'Amoxicillin 250', 30)]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ medication: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      render(<PharmacyDashboard {...props('pharmacy')} medications={priced} canEditPrice />)
      expect(screen.getByRole('columnheader', { name: 'MRP' })).toBeInTheDocument()
      expect(screen.getByText('₹3.50')).toBeInTheDocument()
      expect(screen.getByText('No price')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Edit price of Amoxicillin 250' }))
      fireEvent.change(screen.getByLabelText(/MRP per unit in rupees/), { target: { value: '12.40' } })
      fireEvent.change(screen.getByLabelText('GST rate'), { target: { value: '1200' } })
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(fetchMock).toHaveBeenCalled())
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('/api/pharmacy/medications/2/price')
      expect(JSON.parse(init.body as string)).toEqual({ mrpPerUnitPaise: 1240, gstRateBp: 1200, hsn: null })
    } finally { vi.unstubAllGlobals() }
  })

  it('a non-pricing role sees the MRP without an edit button', () => {
    render(<PharmacyDashboard {...props('pi')} medications={[{ ...med(1, 'Paracetamol 500', 50), mrpPerUnitPaise: 350 }]} />)
    expect(screen.getByText('₹3.50')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit price/i })).toBeNull()
  })
})
