import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { UhidPrefixForm } from '@/components/settings/UhidPrefixForm'

describe('UhidPrefixForm', () => {
  it('previews the first UHID for the typed prefix', () => {
    render(<UhidPrefixForm initialPrefix="UH" isAdmin />)
    expect(screen.getByText('UH000000017')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/UHID prefix/i), { target: { value: 'AB' } })
    expect(screen.getByText('AB000000017')).toBeInTheDocument()
    expect(screen.getByText(/Changing the prefix affects new registrations only/)).toBeInTheDocument()
  })
  it('clears Saved on a further edit and announces errors with role=alert', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<UhidPrefixForm initialPrefix="UH" isAdmin />)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/UHID prefix/i), { target: { value: 'AB' } })
    expect(screen.queryByText('Saved')).toBeNull()
    fetchMock.mockResolvedValueOnce({ ok: false } as never)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not save UHID prefix.'))
    vi.unstubAllGlobals()
  })
  it('is read-only for non-admins', () => {
    render(<UhidPrefixForm initialPrefix="UH" isAdmin={false} />)
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    expect(screen.getByLabelText(/UHID prefix/i)).toBeDisabled()
  })
})
