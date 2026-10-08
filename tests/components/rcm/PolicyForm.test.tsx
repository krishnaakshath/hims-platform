import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { PolicyForm } from '@/components/rcm/PolicyForm'
import { PatientPoliciesPanel, LEGACY_PREFILL_NOTICE } from '@/components/rcm/PatientPoliciesPanel'
import { NATIONAL_ID_MESSAGE } from '@/lib/rcm/identifier-guard'

afterEach(() => vi.unstubAllGlobals())
const PAYERS = [{ payerId: 1, name: 'Star Health', kind: 'insurer' as const }, { payerId: 2, name: 'Medi Assist', kind: 'tpa' as const }]

function fill(over: Record<string, string> = {}) {
  const v: Record<string, string> = { 'Policy number': 'POL/1', 'Member / card ID': 'M-1', 'Policy holder': 'Asha Rao', 'Valid from': '2026-04-01', 'Valid to': '2027-03-31', ...over }
  for (const [label, value] of Object.entries(v)) fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

describe('PolicyForm', () => {
  it('refuses an Aadhaar-like member number with the authored message', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<PolicyForm patientId="P-1" payers={PAYERS} />)
    expect(screen.getByLabelText('Insurer').querySelectorAll('option')).toHaveLength(1)
    fill({ 'Member / card ID': '234123412346' })
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(NATIONAL_ID_MESSAGE)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('needs the employer for a corporate policy, then posts', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ policyId: 5 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PolicyForm patientId="P-1" payers={PAYERS} />)
    fill()
    fireEvent.change(screen.getByLabelText('Policy type'), { target: { value: 'group_corporate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the employer for a corporate policy')
    fireEvent.change(screen.getByLabelText('Employer (corporate policy)'), { target: { value: 'Acme Ltd' } })
    fireEvent.change(screen.getByLabelText('Sum insured (₹)'), { target: { value: '5,00,000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add policy' }))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toMatchObject({ patientId: 'P-1', insurerPayerId: 1, corporateName: 'Acme Ltd', sumInsuredPaise: 5_00_000_00, policyType: 'group_corporate' })
  })
})

describe('PatientPoliciesPanel', () => {
  it('offers the legacy prefill only when there is no policy, and editing only when allowed', () => {
    const { rerender } = render(<PatientPoliciesPanel patientId="P-1" policies={[]} payers={PAYERS} canEdit legacyPrefill={{ memberId: 'OLD-1' }} todayIso="2026-10-08" />)
    expect(screen.getByText(LEGACY_PREFILL_NOTICE, { exact: false })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use them' }))
    expect(screen.getByLabelText('Member / card ID')).toHaveValue('OLD-1')
    const policy = { id: 3, patientId: 'P-1', insurer: { payerId: 1, name: 'Star Health' }, tpa: null, policyNumber: 'POL/1', memberId: 'M-1', planName: null, policyType: 'individual' as const, corporateName: null,
      holderName: 'Asha', relationship: 'self' as const, validFrom: '2025-04-01', validTo: '2026-03-31', sumInsuredPaise: null, copayBp: null, roomRentLimitPaise: null, priority: 'primary' as const, status: 'active' as const, hasCardFront: true, hasCardBack: false }
    rerender(<PatientPoliciesPanel patientId="P-1" policies={[policy]} payers={PAYERS} canEdit={false} legacyPrefill={{ memberId: 'OLD-1' }} todayIso="2026-10-08" />)
    expect(screen.queryByText(LEGACY_PREFILL_NOTICE, { exact: false })).not.toBeInTheDocument()
    expect(screen.getByText('Expired')).toBeInTheDocument()
    expect(screen.getByAltText('Policy card front')).toHaveAttribute('src', '/api/rcm/policies/3/card/front')
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })
})
