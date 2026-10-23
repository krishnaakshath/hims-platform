import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { PatientPoliciesPanel, NOT_ON_NHCX_MESSAGE } from '@/components/rcm/PatientPoliciesPanel'
import type { PolicyCoverage } from '@/lib/queries/coverage'
import type { CoverageVerificationFacts } from '@/lib/insurance/coverage'

afterEach(() => cleanup())

const H = 3_600_000
const NOW = new Date('2026-10-23T06:30:00Z')
const PAYERS = [{ payerId: 1, name: 'Star Health', kind: 'insurer' as const }]
const NO_LIMITS = { sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null }
const POLICY = {
  id: 3, patientId: 'P-1', insurer: { payerId: 1, name: 'Star Health' }, tpa: null, policyNumber: 'POL/1', memberId: 'M-1', planName: null, policyType: 'individual' as const,
  corporateName: null, holderName: 'Asha', relationship: 'self' as const, validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: null, copayBp: null,
  roomRentLimitPaise: null, icuLimitPaise: null, priority: 'primary' as const, status: 'active' as const, hasCardFront: false, hasCardBack: false,
}
const v = (id: number, hoursAgo: number, over: Partial<CoverageVerificationFacts> = {}): CoverageVerificationFacts => ({
  id, source: 'manual', result: 'active', verifiedAt: new Date(NOW.getTime() - hoursAgo * H), validUntil: new Date(NOW.getTime() + (24 - hoursAgo) * H),
  verifiedByName: `Desk ${id}`, method: 'phone', insurerReference: `REF-${id}`, limits: NO_LIMITS, ...over,
})
const current = v(12, 2, {
  source: 'nhcx_mock', method: null, verifiedByName: 'Meera Front Desk', insurerReference: 'CLM-REF-77',
  limits: { sumInsuredPaise: 5_00_000_00, balancePaise: 2_00_000_00, copayBp: 1000, roomRentLimitPaise: 3_000_00, icuLimitPaise: 6_000_00 },
})
const coverage = (over: Partial<PolicyCoverage> = {}): PolicyCoverage => ({
  policyId: 3, current, history: [current, v(11, 40), v(10, 80)], pendingCheckId: null, limits: current.limits,
  verdict: { state: 'verified_active', severity: 'ok', label: 'Policy valid, verified 2 hours ago', detail: null, verifiedHoursAgo: 2, isMock: true, policyId: 3, verificationId: 12 },
  ...over,
})
const panel = (cov: { onNhcx?: boolean; nhcxAvailable?: boolean; canVerify?: boolean; c?: PolicyCoverage } = {}) => (
  <PatientPoliciesPanel patientId="P-1" policies={[POLICY]} payers={PAYERS} canEdit={false} legacyPrefill={null} todayIso="2026-10-23"
    coverage={{ policies: [cov.c ?? coverage()], onNhcx: { 3: cov.onNhcx ?? true }, nhcxAvailable: cov.nhcxAvailable ?? true, canVerify: cov.canVerify ?? true }} />
)

describe('PatientPoliciesPanel coverage (WS12 T4)', () => {
  it('shows the verdict badge with the mock label, the current verification and its limits', () => {
    render(panel())
    expect(screen.getByRole('status')).toHaveTextContent('Policy valid, verified 2 hours ago')
    expect(screen.getByRole('status')).toHaveTextContent('Sandbox mock - not real')
    const cur = screen.getByTestId('current-verification-3')
    expect(cur).toHaveTextContent('Meera Front Desk')
    expect(cur).toHaveTextContent('23 Oct 2026') // when (IST)
    expect(cur).toHaveTextContent('NHCX sandbox mock')
    expect(cur).toHaveTextContent('CLM-REF-77')
    expect(cur).toHaveTextContent('Valid until 24 Oct 2026')
    expect(cur).toHaveTextContent('Sum insured ₹5,00,000.00')
    expect(cur).toHaveTextContent('Balance ₹2,00,000.00')
    expect(cur).toHaveTextContent('Co-pay 10%')
    expect(cur).toHaveTextContent('Room rent ₹3,000.00/day')
    expect(cur).toHaveTextContent('ICU ₹6,000.00/day')
  })

  it('lists the history newest first with who, source and method', () => {
    render(panel())
    const items = within(screen.getByTestId('verification-history-3')).getAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Meera Front Desk'), expect.stringContaining('Desk 11'), expect.stringContaining('Desk 10'),
    ])
    expect(items[1]).toHaveTextContent('manual check by phone')
    expect(items[1]).toHaveTextContent('REF-11')
  })

  it('for an insurer not on NHCX the manual button is the primary action, with the guidance, and opens the dialog', () => {
    render(panel({ onNhcx: false }))
    expect(screen.getByText(NOT_ON_NHCX_MESSAGE)).toBeInTheDocument()
    expect(NOT_ON_NHCX_MESSAGE).toBe('This insurer is not on NHCX: confirm cover with the insurer or TPA, then record it here')
    const btn = screen.getByRole('button', { name: 'Record manual verification' })
    expect(btn).toHaveAttribute('data-variant', 'primary')
    fireEvent.click(btn)
    expect(screen.getByText(/Record manual verification: Star Health/)).toBeInTheDocument()
  })

  it('with NHCX not configured the manual button is primary and says so honestly; on NHCX it is secondary', () => {
    const { unmount } = render(panel({ nhcxAvailable: false }))
    expect(screen.getByRole('button', { name: 'Record manual verification' })).toHaveAttribute('data-variant', 'primary')
    expect(screen.getByText('NHCX not configured: record a manual verification')).toBeInTheDocument()
    unmount()
    render(panel())
    expect(screen.getByRole('button', { name: 'Record manual verification' })).toHaveAttribute('data-variant', 'secondary')
    expect(screen.queryByText(NOT_ON_NHCX_MESSAGE)).not.toBeInTheDocument()
  })

  it('no manual button without the verify role; nothing recorded says so', () => {
    render(panel({ canVerify: false, c: coverage({ current: null, history: [], verdict: { state: 'unverified', severity: 'info', label: 'Not verified', detail: null, verifiedHoursAgo: null, isMock: false, policyId: 3, verificationId: null } }) }))
    expect(screen.queryByRole('button', { name: 'Record manual verification' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Not verified')
    expect(screen.getByText('No verification on record.')).toBeInTheDocument()
  })
})

describe('PolicyForm after add (WS12 T4)', () => {
  it('shows why no NHCX check started, then closes', async () => {
    const { PolicyForm } = await import('@/components/rcm/PolicyForm')
    const body = { policyId: 5, eligibility: { started: false, message: 'NHCX not configured: record a manual verification' } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 201 })))
    const onDone = vi.fn()
    render(<PolicyForm patientId="P-1" payers={PAYERS} onDone={onDone} />)
    const fill: Record<string, string> = { 'Policy number': 'POL/1', 'Member / card ID': 'M-1', 'Policy holder': 'Asha Rao', 'Valid from': '2026-04-01', 'Valid to': '2027-03-31' }
    for (const [label, value] of Object.entries(fill)) fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    expect(await screen.findByText('NHCX not configured: record a manual verification')).toBeInTheDocument()
    expect(screen.getByText('Policy added.')).toBeInTheDocument()
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onDone).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
