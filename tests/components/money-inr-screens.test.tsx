import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { NewChargeModal } from '@/components/NewChargeModal'
import { LogDispenseBillModal } from '@/components/LogDispenseBillModal'
import { PharmacyBillingTable } from '@/components/PharmacyBillingTable'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

describe('billing/pharmacy screens render ₹, never $', () => {
  it('NewChargeModal shows ₹ total and a rupee unit-price input', () => {
    render(<NewChargeModal patients={[{ id: 'RD-0001', name: 'Test Patient' }]} />)
    fireEvent.click(screen.getByText('+ New Charge'))
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Total amount: ₹0.00')
    const price = screen.getByLabelText('Price per unit in rupees')
    fireEvent.change(price, { target: { value: '1,250.50' } })
    expect(dialog.textContent).toContain('Total amount: ₹1,250.50')
    expect(dialog.textContent).not.toContain('$')
    expect(dialog.innerHTML).not.toContain('$')
  })

  it('LogDispenseBillModal labels the unit charge in rupees and totals in ₹', () => {
    render(<LogDispenseBillModal dispense={{ id: 1, medicationName: 'Paracetamol', quantity: 3 }} diagnoses={[{ id: 1, code: 'R50.9', description: 'Fever' }]} onClose={() => {}} />)
    const input = screen.getByLabelText('Unit charge in rupees')
    fireEvent.change(input, { target: { value: '12.5' } })
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('₹37.50')
    expect(dialog.innerHTML).not.toContain('$')
  })

  it('PharmacyBillingTable shows a billed amount in ₹', () => {
    const { container } = render(<PharmacyBillingTable rows={[{ dispenseId: 1, patientId: 'RD-0001', patientName: 'Asha', medicationName: 'Paracetamol', quantity: 2, dispensedByName: 'Ph. Ravi', dispensedAt: '2026-10-08T04:30:00.000Z', charge: { id: 9, status: 'draft', amountCents: 123456 } }]} />)
    expect(container.textContent).toContain('₹1,234.56')
    expect(container.textContent).not.toContain('$')
  })
})

// Grep test: no US-dollar presentation anywhere in the billing/pharmacy screens.
const SRC = join(__dirname, '..', '..', 'src')
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => { const f = join(dir, e); return statSync(f).isDirectory() ? walk(f) : [f] })
}
const MONEY_SCREEN = /(billing|pharmacy|Charge|Billing|Pharmacy|Claims|Collections|Statements|Eligibility|ArAging|Payment|dashboards)/
const DOLLAR_PATTERNS: RegExp[] = [
  /\$\$\{/, // `$${amount}` template literal
  /(^|[\s>:·(])\$\{\([^)]*\/\s*100\b/, // JSX text "$" before {(cents / 100)}
  /['"`(]\s*\$\s*(per\b|\)|['"`])/, // "$ per unit", "($)", '$'
  /\bUSD\b/, /\bdollars?\b/i, /DollarSign/, /formatCents/,
]
describe('grep: billing/pharmacy sources carry no $ currency', () => {
  it('finds none', () => {
    const files = [...walk(join(SRC, 'app')), ...walk(join(SRC, 'components'))]
      .filter((f) => /\.tsx?$/.test(f) && MONEY_SCREEN.test(relative(SRC, f)))
    expect(files.length).toBeGreaterThan(10)
    const offenders = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .map((l, i) => (DOLLAR_PATTERNS.some((p) => p.test(l)) ? `${relative(SRC, f)}:${i + 1}: ${l.trim()}` : null))
      .filter((x): x is string => x !== null))
    expect(offenders).toEqual([])
  })
})
