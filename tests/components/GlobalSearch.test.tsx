import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GlobalSearch } from '@/components/GlobalSearch'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

afterEach(() => { vi.unstubAllGlobals() })

// Wave B P1-24
describe('GlobalSearch', () => {
  it('shows an error instead of crashing when the search route answers non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 })))
    render(<GlobalSearch placeholder="Search patients…" />)
    fireEvent.change(screen.getByRole('combobox', { name: /search/i }), { target: { value: 'asha' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/search is unavailable/i))
  })

  it('shows an error when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    render(<GlobalSearch placeholder="Search patients…" />)
    fireEvent.change(screen.getByRole('combobox', { name: /search/i }), { target: { value: 'asha' } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/search is unavailable/i))
  })

  it('renders the services section from a 200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ patients: [], trials: [], formTemplates: [], services: [{ id: '9', label: 'General consultation', detail: 'CONS-GEN', href: '/tariffs/services/9' }] }), { status: 200 })))
    render(<GlobalSearch placeholder="Search services…" />)
    expect(screen.getByPlaceholderText('Search services…')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('combobox', { name: /search/i }), { target: { value: 'cons' } })
    await waitFor(() => expect(screen.getByRole('option', { name: /general consultation/i })).toBeInTheDocument())
    expect(screen.getByText('Services')).toBeInTheDocument()
  })
})
