import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { RoomTariffMatrix } from '@/components/tariff/RoomTariffMatrix'

const TODAY = '2026-10-07'
const services = [{ id: 1, code: 'BED', name: 'Bed charge' }, { id: 2, code: 'NURS', name: 'Nursing room charge' }]
const categories = [{ id: 10, code: 'GENERAL', name: 'General' }, { id: 11, code: 'ICU', name: 'Intensive Care' }]
const r = (over: Record<string, unknown>) => ({
  serviceId: 1, scope: 'base', roomCategoryId: null, ward: null, amountPaise: 100000, validFrom: '2026-01-01', validTo: null, deactivated: false, ...over,
}) as never

describe('RoomTariffMatrix', () => {
  it('shows the current per-day base rate per category and lists ward overrides', () => {
    render(<RoomTariffMatrix today={TODAY} services={services} categories={categories} rates={[
      r({ roomCategoryId: 10, amountPaise: 150000 }),
      r({ roomCategoryId: 11, amountPaise: 1250000 }),
      r({ roomCategoryId: 11, amountPaise: 999999, validFrom: '2026-10-08' }), // scheduled: not current
      r({ roomCategoryId: 10, amountPaise: 1, validTo: '2026-10-06' }), // ended
      r({ roomCategoryId: 10, ward: 'icu ward', amountPaise: 275000 }), // override
      r({ serviceId: 2, scope: 'department', roomCategoryId: 10, amountPaise: 777700 }), // not base
    ]} />)
    const row = screen.getByRole('link', { name: 'Bed charge' }).closest('tr')!
    expect(within(row).getByText('₹1,500.00')).toBeInTheDocument()
    expect(within(row).getByText('₹12,500.00')).toBeInTheDocument()
    expect(screen.queryByText('₹9,999.99')).not.toBeInTheDocument()
    expect(screen.queryByText('₹0.01')).not.toBeInTheDocument()
    expect(screen.queryByText('₹7,777.00')).not.toBeInTheDocument()
    const overrides = screen.getByRole('region', { name: /ward overrides/i })
    expect(within(overrides).getByText(/icu ward/)).toBeInTheDocument()
    expect(within(overrides).getByText('₹2,750.00')).toBeInTheDocument()
  })

  it('links each service to its detail page and shows a dash where no rate exists', () => {
    render(<RoomTariffMatrix today={TODAY} services={services} categories={categories} rates={[]} />)
    expect(screen.getByRole('link', { name: 'Nursing room charge' })).toHaveAttribute('href', '/tariffs/services/2')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText(/no ward-specific overrides/i)).toBeInTheDocument()
  })

  it('shows an empty state when there are no room-rent services', () => {
    render(<RoomTariffMatrix today={TODAY} services={[]} categories={categories} rates={[]} />)
    expect(screen.getByText(/no room-rent services/i)).toBeInTheDocument()
  })
})
