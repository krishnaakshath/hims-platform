import { describe, it, expect, vi, afterEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { HospitalIdentifiersForm } from '@/components/rcm/HospitalIdentifiersForm'

afterEach(() => vi.unstubAllGlobals())

function okFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('HospitalIdentifiersForm', () => {
  it('says what the saved identifiers unlock', async () => {
    okFetch()
    render(<HospitalIdentifiersForm rohiniId="1234567890123" hfrId="IN0123456789" />)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. Claims and NHCX checks will use these identifiers.')
  })

  it('says claims and NHCX checks are blocked when both are cleared', async () => {
    okFetch()
    render(<HospitalIdentifiersForm rohiniId="1234567890123" hfrId="IN0123456789" />)
    fireEvent.change(screen.getByLabelText('ROHINI ID (13 digits)'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('HFR facility ID (IN + 10 digits)'), { target: { value: ' ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Both cleared: claims and NHCX checks are blocked until they are set.')
  })

  it('shows no confirmation when the save is refused', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'ROHINI must be 13 digits' }), { status: 400 })))
    render(<HospitalIdentifiersForm rohiniId={null} hfrId={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('ROHINI must be 13 digits')
    expect(screen.queryByRole('status')).toBeNull()
  })
})
