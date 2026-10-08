import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// Wave E P1-19: /billing/charges takes ?status= (opens the table on that
// status; the user can still clear it) and ?source=pharmacy (only the bills
// raised from a dispense). Unknown values are ignored.
vi.mock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'billing', name: 'T', userId: null })) }))
vi.mock('next/navigation', () => ({ redirect: (p: string) => { throw new Error(`REDIRECT ${p}`) } }))
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
const charge = (id: number, status: string) => ({ id, status, patientId: 'RD-1', patientName: 'P', providerName: 'D', dateOfService: '2026-10-08', diagnosisCodes: [], procedureCodes: [], amountCents: 100, notes: null, createdAt: '2026-10-08T00:00:00.000Z' })
vi.mock('@/lib/queries/charges', () => ({ listCharges: vi.fn(async () => [charge(1, 'draft'), charge(2, 'draft'), charge(3, 'pending_approval')]) }))
vi.mock('@/lib/queries/patients', () => ({ listPatientsWithStatus: vi.fn(async () => []) }))
vi.mock('@/lib/queries/medication-dispenses', () => ({ listPharmacyChargeIds: vi.fn(async () => [2]) }))
vi.mock('@/components/ChargesTable', () => ({
  ChargesTable: ({ charges, initialStatus }: { charges: { id: number }[]; initialStatus?: string }) => <p>rows={charges.map((c) => c.id).join(',')} status={initialStatus ?? 'any'}</p>,
}))

import ChargesPage from '@/app/(dashboard)/billing/charges/page'

const run = async (sp: Record<string, string>) => render(await ChargesPage({ searchParams: Promise.resolve(sp) }))

describe('/billing/charges filters', () => {
  it('no params: every charge, no status preset', async () => {
    await run({})
    expect(screen.getByText('rows=1,2,3 status=any')).toBeInTheDocument()
  })

  it('?status=pending_approval presets the table filter', async () => {
    await run({ status: 'pending_approval' })
    expect(screen.getByText('rows=1,2,3 status=pending_approval')).toBeInTheDocument()
  })

  it('an unknown status is ignored', async () => {
    await run({ status: 'paid' })
    expect(screen.getByText('rows=1,2,3 status=any')).toBeInTheDocument()
  })

  it('?source=pharmacy lists only pharmacy bills, with a way back to every charge', async () => {
    await run({ source: 'pharmacy', status: 'draft' })
    expect(screen.getByText('rows=2 status=draft')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /show every charge/i })).toHaveAttribute('href', '/billing/charges')
  })
})
