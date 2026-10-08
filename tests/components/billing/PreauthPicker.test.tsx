import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { PreauthPicker } from '@/components/billing/PreauthPicker'

afterEach(() => vi.unstubAllGlobals())

describe('PreauthPicker', () => {
  it('lists approved pre-auths and keeps free text', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ preauths: [{ id: 1, preauthNumber: 'PA-2026-000001', approvalReference: 'AR/9', approvedPaise: 80_000_00, validUntil: '2026-10-31', payerIds: [1] }] })))
    vi.stubGlobal('fetch', fetchMock)
    const onChange = vi.fn()
    render(<PreauthPicker patientId="P-1" serviceDate="2026-10-20" value="" onChange={onChange} inputId="x" />)
    const option = await screen.findByRole('button', { name: 'PA-2026-000001 · AR/9 · ₹80,000.00 · valid to 31 Oct 2026' })
    expect(fetchMock).toHaveBeenCalledWith('/api/rcm/patients/P-1/approved-preauths?onDate=2026-10-20', undefined)
    fireEvent.click(option)
    expect(onChange).toHaveBeenLastCalledWith('AR/9')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TYPED-1' } })
    expect(onChange).toHaveBeenLastCalledWith('TYPED-1')
  })
})
