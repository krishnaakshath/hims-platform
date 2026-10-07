import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { ContactsSection } from '@/components/registration/ContactsSection'
import { EMPTY_REGISTRATION_FORM, type RegistrationFormState } from '@/components/registration/registration-form-state'

function Harness({ errors = {} }: { errors?: Record<string, string> }) {
  const [form, setForm] = useState<RegistrationFormState>(EMPTY_REGISTRATION_FORM)
  const update = <K extends keyof RegistrationFormState>(k: K, v: RegistrationFormState[K]) => setForm((f) => ({ ...f, [k]: v }))
  return <ContactsSection form={form} update={update} errors={errors} />
}

describe('ContactsSection', () => {
  it('adds and removes contact rows up to five', () => {
    render(<Harness />)
    const add = screen.getByRole('button', { name: /add contact/i })
    for (let i = 0; i < 7; i++) if (!(add as HTMLButtonElement).disabled) fireEvent.click(add)
    expect(screen.getAllByLabelText(/contact \d+ name/i)).toHaveLength(5)
    expect(add).toBeDisabled()
    fireEvent.click(screen.getAllByRole('button', { name: /remove contact/i })[0])
    expect(screen.getAllByLabelText(/contact \d+ name/i)).toHaveLength(4)
    expect(add).not.toBeDisabled()
  })

  it('shows the guardian error at contacts', () => {
    render(<Harness errors={{ contacts: 'A guardian contact is required for a patient under 18' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/guardian/i)
  })

  it('shows a per-row phone error', () => {
    const update = vi.fn()
    render(<ContactsSection form={{ ...EMPTY_REGISTRATION_FORM, contacts: [{ kind: 'emergency', name: 'x', relationship: 'friend', phone: '1', addressText: '' }] }} update={update} errors={{ 'contacts.0.phone': 'Enter a valid phone number' }} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid phone number')
  })
})
