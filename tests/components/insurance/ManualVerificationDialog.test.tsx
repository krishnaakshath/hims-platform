import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
import { ManualVerificationDialog } from '@/components/insurance/ManualVerificationDialog'
import { CARD_UPLOAD_WARNING } from '@/components/rcm/PolicyCardUpload'

afterEach(() => { vi.unstubAllGlobals(); refresh.mockClear() })

const props = { policyId: 7, insurerName: 'Star Health', policyValidTo: '2027-03-31', todayIso: '2026-10-23' }

describe('ManualVerificationDialog', () => {
  it('shows the national-ID warning and the insurer, with valid-until defaulted to today + 7 within today + 30', () => {
    render(<ManualVerificationDialog {...props} onSaved={vi.fn()} />)
    expect(screen.getByText(CARD_UPLOAD_WARNING)).toBeInTheDocument()
    expect(screen.getByText(/Star Health/)).toBeInTheDocument()
    expect(screen.getByLabelText('Verified on')).toHaveValue('2026-10-23')
    expect(screen.getByLabelText('Verified on')).toHaveAttribute('max', '2026-10-23')
    expect(screen.getByLabelText('Valid until')).toHaveValue('2026-10-30')
    expect(screen.getByLabelText('Valid until')).toHaveAttribute('min', '2026-10-23')
    expect(screen.getByLabelText('Valid until')).toHaveAttribute('max', '2026-11-22')
  })

  it('caps valid-until at the policy end', () => {
    render(<ManualVerificationDialog {...props} policyValidTo="2026-10-26" onSaved={vi.fn()} />)
    expect(screen.getByLabelText('Valid until')).toHaveValue('2026-10-26')
    expect(screen.getByLabelText('Valid until')).toHaveAttribute('max', '2026-10-26')
  })

  it('disables Save until method, reference and dates are filled, naming what is missing', () => {
    render(<ManualVerificationDialog {...props} onSaved={vi.fn()} />)
    const save = screen.getByRole('button', { name: 'Save verification' })
    expect(save).toBeDisabled()
    expect(screen.getByText('Still needed: how it was verified, reference')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('How it was verified'), { target: { value: 'phone' } })
    expect(screen.getByText('Still needed: reference')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Insurer / TPA reference'), { target: { value: 'AB' } })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Insurer / TPA reference'), { target: { value: 'ABC-123' } })
    fireEvent.change(screen.getByLabelText('Valid until'), { target: { value: '' } })
    expect(screen.getByText('Still needed: valid until')).toBeInTheDocument()
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Valid until'), { target: { value: '2026-10-28' } })
    expect(save).toBeEnabled()
    expect(screen.queryByText(/Still needed/)).toBeNull()
  })

  it('posts multipart with paise and basis points, then calls onSaved with the id', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ verificationId: 41 }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const onSaved = vi.fn()
    render(<ManualVerificationDialog {...props} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText('How it was verified'), { target: { value: 'tpa_portal' } })
    fireEvent.change(screen.getByLabelText('Insurer / TPA reference'), { target: { value: 'TPA-9' } })
    fireEvent.change(screen.getByLabelText('Balance (₹)'), { target: { value: '4,50,000' } })
    fireEvent.change(screen.getByLabelText('Co-pay (%)'), { target: { value: '10' } })
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'letter.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Confirmation document (optional)'), { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Save verification' }))
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith(41))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/rcm/policies/7/verifications')
    const body = init.body as FormData
    expect(body.get('result')).toBe('active')
    expect(body.get('method')).toBe('tpa_portal')
    expect(body.get('reference')).toBe('TPA-9')
    expect(body.get('balancePaise')).toBe('45000000')
    expect(body.get('copayBp')).toBe('1000')
    expect(body.has('sumInsuredPaise')).toBe(false)
    expect(body.get('file')).toBeInstanceOf(File)
  })

  it('shows the route error and does not call onSaved', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'File storage is not set up. Ask your administrator.', code: 'storage_not_configured' }), { status: 503 })))
    const onSaved = vi.fn()
    render(<ManualVerificationDialog {...props} onSaved={onSaved} />)
    fireEvent.change(screen.getByLabelText('How it was verified'), { target: { value: 'email' } })
    fireEvent.change(screen.getByLabelText('Insurer / TPA reference'), { target: { value: 'MAIL-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save verification' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('File storage is not set up. Ask your administrator.')
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('refuses an unreadable amount before posting', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<ManualVerificationDialog {...props} onSaved={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('How it was verified'), { target: { value: 'letter' } })
    fireEvent.change(screen.getByLabelText('Insurer / TPA reference'), { target: { value: 'LTR-1' } })
    fireEvent.change(screen.getByLabelText('Sum insured (₹)'), { target: { value: 'five lakh' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save verification' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter the sum insured in rupees')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
