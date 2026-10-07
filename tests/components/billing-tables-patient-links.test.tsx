import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PatientCollectionsTable } from '@/components/PatientCollectionsTable'
import { PatientStatementsTable } from '@/components/PatientStatementsTable'
import { InsuranceClaimsTable } from '@/components/InsuranceClaimsTable'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

const rows = [{ patientId: 'RD-0001', patientName: 'Zzprobe Quillfeather', balanceCents: 5000, unappliedCents: 0 }]
const statements = [{
  id: 1, patientId: 'RD-0001', patientName: 'Zzprobe Quillfeather', amountCents: 5000,
  deliveryMethod: 'email' as const, type: 'initial' as const, deliveryStatus: 'delivered' as const, sentDate: '2026-09-01',
}]
const claims = [{
  id: 1, patientId: 'RD-0001', patientName: 'Zzprobe Quillfeather', payerName: 'Acme Health',
  billedAmountCents: 10000, paidAmountCents: null, status: 'denied' as const, submittedDate: '2026-09-01', dateOfService: '2026-08-30',
}]

const tables = [
  { name: 'PatientCollectionsTable', el: (link?: boolean) => <PatientCollectionsTable rows={rows} linkPatients={link} /> },
  { name: 'PatientStatementsTable', el: (link?: boolean) => <PatientStatementsTable statements={statements} linkPatients={link} /> },
  { name: 'InsuranceClaimsTable', el: (link?: boolean) => <InsuranceClaimsTable claims={claims} linkPatients={link} /> },
]

describe.each(tables)('$name patient links', ({ el }) => {
  it('linkPatients={false} renders the patient name with no /patients link', () => {
    const { container } = render(el(false))
    const name = screen.getByText(/Zzprobe Quillfeather/)
    expect(name.tagName).toBe('SPAN')
    expect(name).toHaveClass('font-medium', 'text-foreground')
    expect(container.querySelector('a[href^="/patients/"]')).toBeNull()
  })

  it('default keeps the link', () => {
    const { container } = render(el())
    const link = container.querySelector('a[href="/patients/RD-0001"]')
    expect(link).not.toBeNull()
    expect(link).toHaveTextContent(/Zzprobe Quillfeather/)
  })
})

// Wave B P1-21: "Collect Payment" opens the demo card form -- hidden when DEMO_FEATURES is off.
describe('PatientCollectionsTable Collect Payment', () => {
  it('links to the demo card payment by default', () => {
    render(<PatientCollectionsTable rows={rows} />)
    expect(screen.getByRole('link', { name: /collect payment/i })).toHaveAttribute('href', expect.stringContaining('/billing/pay'))
  })
  it('hides the link when showCollectPayment is false', () => {
    render(<PatientCollectionsTable rows={rows} showCollectPayment={false} />)
    expect(screen.queryByRole('link', { name: /collect payment/i })).not.toBeInTheDocument()
  })
})
