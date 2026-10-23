import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/toast'
import { addDaysIso } from '@/lib/follow-ups/rules'
import type { BatchStock } from '@/lib/pharmacy/fefo'
import type { MedicationWithInventory } from '@/lib/queries/medications'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh }), usePathname: () => '/pharmacy' }))
vi.mock('@/components/DispenseMedicationModal', () => ({ DispenseMedicationModal: () => null }))
vi.mock('@/components/AddMedicationModal', () => ({
  AddMedicationModal: ({ initialName }: { initialName?: string }) => <div data-testid="add-medication">{initialName}</div>,
}))
afterEach(() => { vi.unstubAllGlobals(); refresh.mockReset() })

import { PharmacyDashboard } from '@/components/dashboards/PharmacyDashboard'

// WS5 T4: batches, expiry alerts, reorder level and write-off on the stock table.
const TODAY = '2026-10-23'
const batch = (id: number, batchNo: string, quantityOnHand: number, expiryDate: string | null, writtenOff = false): BatchStock =>
  ({ id, batchNo, expiryDate, quantityOnHand, mrpPerUnitPaise: 250, writtenOff })

function med(id: number, name: string, batches: BatchStock[], reorderThreshold = 5): MedicationWithInventory {
  const live = batches.filter((b) => !b.writtenOff && b.quantityOnHand > 0)
  const dated = live.map((b) => b.expiryDate).filter((d): d is string => d !== null).sort()
  return {
    id, name, genericName: null, medicationClass: 'Test', commonDose: null, form: 'tablet', unit: 'tabs', reorderThreshold,
    mrpPerUnitPaise: null, gstRateBp: null, hsn: null, effectiveGstRateBp: 500, // WS2 T8
    quantityOnHand: live.reduce((s, b) => s + b.quantityOnHand, 0),
    batches,
    nearestExpiry: dated[0] ?? null,
    expiringSoonQty: live.filter((b) => b.expiryDate !== null && b.expiryDate >= TODAY && b.expiryDate <= addDaysIso(TODAY, 90)).reduce((s, b) => s + b.quantityOnHand, 0),
    expiredQty: live.filter((b) => b.expiryDate !== null && b.expiryDate < TODAY).reduce((s, b) => s + b.quantityOnHand, 0),
  }
}

const SOON = med(1, 'Paracetamol 500', [batch(11, 'PCM-23', 40, addDaysIso(TODAY, 23)), batch(12, 'PCM-LATE', 60, '2099-12-31')])
const EXPIRED = med(2, 'Amoxicillin 250', [batch(21, 'AMX-OLD', 7, addDaysIso(TODAY, -5)), batch(22, 'AMX-NEW', 50, '2099-12-31'), batch(23, 'AMX-DMG', 0, '2099-12-31', true)])
const FINE = med(3, 'Metformin 500', [batch(31, 'MET-1', 100, '2099-12-31')])
const MEDS = [SOON, EXPIRED, FINE]
const KPIS = { outOfStock: 0, lowStock: 0, dispensedToday: 0, unbilledDispenses: 0, expiringIn90Days: 1, expiredBatches: 1 }

type Filter = 'out' | 'low' | 'expiring' | 'expired' | null
const props = (role: 'pharmacy' | 'admin' | 'pi', stockFilter: Filter = null, medications = MEDS) => ({
  session: { role, name: 'T', userId: null },
  medications,
  canDispense: true,
  prescribedSummary: [{ name: 'Paracetemol', medicationClass: 'Analgesic', activeEpisodeCount: 3, inCatalog: false }],
  canAddMedication: role !== 'pi',
  kpis: KPIS,
  stockFilter,
  canUseCounter: role !== 'pi',
  today: TODAY,
})
const renderDash = (p: ReturnType<typeof props>) => render(<ToastProvider><PharmacyDashboard {...p} /></ToastProvider>)
const rowOf = (name: string) => screen.getByText(name).closest('tr')!

describe('PharmacyDashboard stock (WS5 T4)', () => {
  it('shows reorder level, nearest expiry in IST days, and an Expired chip', () => {
    renderDash(props('pharmacy'))
    const soon = rowOf('Paracetamol 500')
    expect(within(soon).getByText('Expires in 23 days')).toBeInTheDocument()
    expect(within(soon).getByText('5')).toBeInTheDocument()
    expect(within(soon).getByText('Expiring')).toBeInTheDocument()
    expect(within(rowOf('Amoxicillin 250')).getByText('Expired')).toBeInTheDocument()
    expect(within(rowOf('Metformin 500')).queryByText('Expired')).toBeNull()
  })

  it('expiry tiles drill into ?stock=expiring and ?stock=expired', () => {
    const { container } = renderDash(props('pharmacy'))
    expect(container.querySelector('a[href="/pharmacy?stock=expiring"]')).not.toBeNull()
    expect(container.querySelector('a[href="/pharmacy?stock=expired"]')).not.toBeNull()
  })

  it('?stock=expiring lists only drugs with live stock expiring within 90 days', () => {
    renderDash(props('pharmacy', 'expiring'))
    expect(screen.getByText('Paracetamol 500')).toBeInTheDocument()
    expect(screen.queryByText('Amoxicillin 250')).toBeNull()
    expect(screen.queryByText('Metformin 500')).toBeNull()
  })

  it('?stock=expired lists only drugs holding expired stock', () => {
    renderDash(props('pharmacy', 'expired'))
    expect(screen.getByText('Amoxicillin 250')).toBeInTheDocument()
    expect(screen.queryByText('Paracetamol 500')).toBeNull()
  })

  it('an empty filter result renders the empty state with a way back', () => {
    renderDash(props('pharmacy', 'expired', [SOON, FINE]))
    expect(screen.getByText('No medications match this filter')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /show all stock/i })[0]).toHaveAttribute('href', '/pharmacy')
  })

  it('a row expands to its batches; a written-off batch has no write-off button', () => {
    renderDash(props('pharmacy'))
    fireEvent.click(screen.getByRole('button', { name: 'Show batches of Amoxicillin 250' }))
    expect(screen.getByText('AMX-OLD')).toBeInTheDocument()
    expect(screen.getByText('AMX-DMG')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Write off batch AMX-OLD' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Write off batch AMX-NEW' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Write off batch AMX-DMG' })).toBeNull()
    expect(screen.getByText('Written off')).toBeInTheDocument()
  })

  it('writes off a batch with a reason and refreshes the stock', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderDash(props('pharmacy'))
    fireEvent.click(screen.getByRole('button', { name: 'Show batches of Amoxicillin 250' }))
    fireEvent.click(screen.getByRole('button', { name: 'Write off batch AMX-OLD' }))
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'expired' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm write-off' }))
    expect(await screen.findByText('Batch AMX-OLD written off')).toBeInTheDocument()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/pharmacy/batches/21/write-off')
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'expired' })
    expect(refresh).toHaveBeenCalled()
  })

  it('edits the reorder level', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ reorderThreshold: 25 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderDash(props('pharmacy'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit reorder level of Metformin 500' }))
    fireEvent.change(screen.getByLabelText('Reorder level of Metformin 500'), { target: { value: '25' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Reorder level saved')).toBeInTheDocument()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pharmacy/medications/3/reorder')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ reorderThreshold: 25 })
  })

  it('links a not-in-catalogue prescription name to a catalogue drug, or opens Add prefilled', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ linked: 3 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    renderDash(props('pharmacy'))
    fireEvent.click(screen.getByRole('button', { name: 'Add to catalog' }))
    expect(screen.getByTestId('add-medication')).toHaveTextContent('Paracetemol')
    fireEvent.click(screen.getByRole('button', { name: 'Link to drug' }))
    fireEvent.change(screen.getByLabelText('Catalogue drug for Paracetemol'), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Link' }))
    expect(await screen.findByText('3 prescriptions linked to Paracetamol 500')).toBeInTheDocument()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pharmacy/uncatalogued/link')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ episodeName: 'Paracetemol', medicationId: 1 })
  })

  it('pi (view-only) sees batches but no write-off, reorder edit, link or add buttons', () => {
    renderDash(props('pi'))
    fireEvent.click(screen.getByRole('button', { name: 'Show batches of Amoxicillin 250' }))
    expect(screen.getByText('AMX-OLD')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /write off/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /edit reorder level/i })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Link to drug' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add to catalog' })).toBeNull()
  })
})
