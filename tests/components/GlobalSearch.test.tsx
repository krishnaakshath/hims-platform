import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { GlobalSearch } from '@/components/GlobalSearch'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))

afterEach(() => { vi.unstubAllGlobals(); push.mockClear() })

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

  // Wave G: keyboard UX.
  const TWO = { patients: [{ id: 'RD-0001', label: 'Asha Rao', detail: 'RD-0001', href: '/patients/RD-0001' }], trials: [], formTemplates: [], services: [{ id: '9', label: 'General consultation', detail: 'CONS-GEN', href: '/price-lookup?serviceId=9' }] }

  async function typed(q: string) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(TWO), { status: 200 })))
    render(<GlobalSearch placeholder="Search…" />)
    const box = screen.getByRole('combobox', { name: /search/i })
    fireEvent.change(box, { target: { value: q } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))
    return box
  }

  it('moves through every result with the arrow keys and opens it with Enter', async () => {
    const box = await typed('a')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /asha rao/i })).toHaveAttribute('aria-selected', 'true')
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /asha rao/i }).id)
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(screen.getByRole('option', { name: /general consultation/i })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box, { key: 'ArrowDown' }) // wraps
    expect(screen.getByRole('option', { name: /asha rao/i })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(box, { key: 'ArrowUp' }) // wraps back
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(push).toHaveBeenCalledWith('/price-lookup?serviceId=9')
  })

  it('Enter with nothing highlighted opens the first result', async () => {
    const box = await typed('a')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(push).toHaveBeenCalledWith('/patients/RD-0001')
  })

  it('Escape closes the list, a second Escape clears the box', async () => {
    const box = await typed('a')
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box).toHaveValue('')
  })

  it('focuses the search box on Ctrl+K or "/" outside a text field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(TWO), { status: 200 })))
    render(<GlobalSearch placeholder="Search…" />)
    const box = screen.getByRole('combobox', { name: /search/i })
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true })
    expect(box).toHaveFocus()
    box.blur()
    fireEvent.keyDown(document.body, { key: '/' })
    expect(box).toHaveFocus()
  })
})
