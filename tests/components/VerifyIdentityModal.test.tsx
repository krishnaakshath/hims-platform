import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { VerifyIdentityButton } from '@/components/patient-profile/VerifyIdentityButton'
import { KYC_DOC_LABELS } from '@/lib/india/reference'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))

afterEach(() => { vi.unstubAllGlobals(); refresh.mockClear() })

function open() {
  render(<VerifyIdentityButton anonId="RD-0001" verified={false} />)
  fireEvent.click(screen.getByRole('button', { name: /verify identity/i }))
}

// Wave B P1-09
describe('VerifyIdentityButton', () => {
  it('offers exactly the KYC document types -- never Aadhaar', () => {
    open()
    const options = Array.from((screen.getByLabelText(/id document/i) as HTMLSelectElement).options).map((o) => o.textContent)
    expect(options.filter(Boolean)).toEqual(['Select a document', ...Object.values(KYC_DOC_LABELS)])
    expect(options.join(' ')).not.toMatch(/aadhaar/i)
  })

  it('blocks an Aadhaar-shaped number before sending it anywhere', async () => {
    const fetchFn = vi.fn()
    vi.stubGlobal('fetch', fetchFn)
    open()
    fireEvent.change(screen.getByLabelText(/id document/i), { target: { value: 'pan' } })
    fireEvent.change(screen.getByLabelText(/document number/i), { target: { value: '2345 6789 0124' } })
    fireEvent.click(screen.getByRole('button', { name: /mark verified/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/aadhaar/i)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('PUTs the document and refreshes the page on success', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchFn)
    open()
    fireEvent.change(screen.getByLabelText(/id document/i), { target: { value: 'voter_id' } })
    fireEvent.change(screen.getByLabelText(/document number/i), { target: { value: ' ABC1234567 ' } })
    fireEvent.click(screen.getByRole('button', { name: /mark verified/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(fetchFn).toHaveBeenCalledWith('/api/patients/RD-0001/identity', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ idType: 'voter_id', idNumber: 'ABC1234567' }) }))
  })

  it('shows the server error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Patient not found' }), { status: 404 })))
    open()
    fireEvent.change(screen.getByLabelText(/id document/i), { target: { value: 'passport' } })
    fireEvent.change(screen.getByLabelText(/document number/i), { target: { value: 'P1234567' } })
    fireEvent.click(screen.getByRole('button', { name: /mark verified/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Patient not found')
    expect(refresh).not.toHaveBeenCalled()
  })
})
