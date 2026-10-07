import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { FrontDeskDuplicateWarning } from '@/components/FrontDeskPatientSearch'

afterEach(() => vi.unstubAllGlobals())

// Wave B P1-10
describe('FrontDeskDuplicateWarning', () => {
  it('warns with name, UHID and id for each possible match', async () => {
    const fetchFn = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify([{ id: 'RD-0001', name: 'Asha Rao', dob: '1990-01-01', uhid: 'UH000001' }]), { status: 200 }))
    vi.stubGlobal('fetch', fetchFn)
    render(<FrontDeskDuplicateWarning name="Asha Rao" dob="1990-01-01" phone="9812300077" />)
    const warning = await screen.findByRole('status')
    expect(warning).toHaveTextContent(/possible existing patient/i)
    expect(warning).toHaveTextContent('Asha Rao')
    expect(warning).toHaveTextContent('UH000001')
    expect(String(fetchFn.mock.calls[0][0])).toContain('phone=9812300077')
  })

  it('checks by mobile even before name and DOB are complete', async () => {
    const fetchFn = vi.fn<(url: string) => Promise<Response>>(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchFn)
    render(<FrontDeskDuplicateWarning name="" dob="" phone="9812300077" />)
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    expect(String(fetchFn.mock.calls[0][0])).toBe('/api/front-desk/patient-lookup?phone=9812300077')
  })

  it('renders nothing for a non-array or failed response', async () => {
    vi.stubGlobal('fetch', vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify({ id: 7 }), { status: 200 })))
    const { container } = render(<FrontDeskDuplicateWarning name="Asha Rao" dob="1990-01-01" />)
    await new Promise((r) => setTimeout(r, 400))
    expect(container).toBeEmptyDOMElement()
  })
})
