import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UhidPrefixForm } from '@/components/settings/UhidPrefixForm'

describe('UhidPrefixForm', () => {
  it('previews the first UHID for the typed prefix', () => {
    render(<UhidPrefixForm initialPrefix="UH" isAdmin />)
    expect(screen.getByText('UH000000017')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/UHID prefix/i), { target: { value: 'AB' } })
    expect(screen.getByText('AB000000017')).toBeInTheDocument()
    expect(screen.getByText(/Changing the prefix affects new registrations only/)).toBeInTheDocument()
  })
  it('is read-only for non-admins', () => {
    render(<UhidPrefixForm initialPrefix="UH" isAdmin={false} />)
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull()
    expect(screen.getByLabelText(/UHID prefix/i)).toBeDisabled()
  })
})
