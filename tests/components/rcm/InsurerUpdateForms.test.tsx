import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { InsurerUpdateForms } from '@/components/rcm/InsurerUpdateForms'
import type { RcmReasonCodeRow } from '@/db/schema'

afterEach(() => vi.unstubAllGlobals())
const CODES: RcmReasonCodeRow[] = [
  { code: 'NME', label: 'Non-medical expenses not payable', category: 'disallowance', patientRecoverableDefault: true, active: true, sortOrder: 10 },
  { code: 'TARIFF', label: 'Charged above the agreed tariff or package rate', category: 'disallowance', patientRecoverableDefault: false, active: true, sortOrder: 50 },
  { code: 'EXCL', label: 'Policy exclusion', category: 'rejection', patientRecoverableDefault: true, active: true, sortOrder: 60 },
]

describe('InsurerUpdateForms', () => {
  it('the decision form shows the deduction gap live and blocks submit until it is zero', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'partially_approved', warnings: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<InsurerUpdateForms claimId={4} claimedPaise={1_00_000_00} reasonCodes={CODES} allowedActions={['record_query', 'record_approval', 'record_partial_approval', 'record_rejection', 'withdraw', 'note']} />)
    fireEvent.change(screen.getByLabelText('Approved (₹)'), { target: { value: '80000' } })
    fireEvent.change(screen.getAllByLabelText('Decided on')[0], { target: { value: '2026-10-10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add deduction' }))
    fireEvent.change(screen.getByLabelText('Deduction amount'), { target: { value: '15000' } })
    expect(screen.getByText('Disallowed amounts must add up to the claimed amount less the approved amount (₹20,000.00)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Record decision' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Deduction amount'), { target: { value: '20000' } })
    expect(screen.getByRole('button', { name: 'Record decision' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Record decision' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/rcm/claims/4/actions')
    expect(JSON.parse(init.body as string)).toEqual({ action: 'record_decision', approvedPaise: 80_000_00, decidedOn: '2026-10-10', disallowances: [{ reasonCode: 'NME', amountPaise: 20_000_00, patientRecoverable: true }] })
  })
  it('shows only the forms the status allows', () => {
    render(<InsurerUpdateForms claimId={4} claimedPaise={100} reasonCodes={CODES} allowedActions={['close', 'note']} />)
    expect(screen.queryByText('Record the decision')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Close the claim' })).toBeInTheDocument()
  })
})
