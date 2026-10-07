import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NationalIdSection } from '@/components/registration/NationalIdSection'
import { EMPTY_REGISTRATION_FORM, type RegistrationFormState } from '@/components/registration/registration-form-state'

function setup(over: Partial<RegistrationFormState> = {}, errors: Record<string, string> = {}) {
  const update = vi.fn()
  render(<NationalIdSection form={{ ...EMPTY_REGISTRATION_FORM, ...over }} update={update} errors={errors} />)
  return update
}

describe('NationalIdSection', () => {
  it('Aadhaar input is numeric and autocomplete-off', () => {
    setup()
    const el = screen.getByLabelText('Aadhaar number')
    expect(el).toHaveAttribute('inputmode', 'numeric')
    expect(el).toHaveAttribute('autocomplete', 'off')
  })

  it('keeps only digits (max 12) when typing', () => {
    const update = setup()
    fireEvent.change(screen.getByLabelText('Aadhaar number'), { target: { value: '2345 6789-0125 99' } })
    expect(update).toHaveBeenCalledWith('aadhaarNumber', '234567890125')
  })

  it('requires the consent checkbox label', () => {
    setup()
    expect(screen.getByLabelText('Patient consents to recording their Aadhaar number')).toBeRequired()
  })

  it('hides the Aadhaar input and shows reason select when declined', () => {
    setup({ aadhaarMode: 'declined' })
    expect(screen.queryByLabelText('Aadhaar number')).toBeNull()
    expect(screen.getByLabelText('Reason for no Aadhaar')).toBeInTheDocument()
  })

  it('toggle switches the mode', () => {
    const update = setup()
    fireEvent.click(screen.getByLabelText('Patient does not provide Aadhaar'))
    expect(update).toHaveBeenCalledWith('aadhaarMode', 'declined')
  })

  it('never offers Aadhaar in the KYC document type select', () => {
    setup()
    const sel = screen.getByLabelText('Other ID document type')
    const opts = Array.from(sel.querySelectorAll('option')).map((o) => `${o.value} ${o.textContent}`.toLowerCase())
    expect(opts.some((o) => o.includes('aadhaar'))).toBe(false)
    expect(opts.some((o) => o.includes('passport'))).toBe(true)
  })

  it('ABHA fields carry the ABDM hint and the unavailable toggle reveals a reason', () => {
    setup()
    expect(screen.getAllByText(/ABDM not connected/i).length).toBe(2)
  })

  it('ABHA unavailable reveals the reason select', () => {
    setup({ abhaMode: 'unavailable' })
    expect(screen.getByLabelText('Reason ABHA is not available')).toBeInTheDocument()
  })

  it('shows field errors with alert role', () => {
    setup({}, { 'aadhaar.number': 'Enter a valid 12-digit Aadhaar number' })
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid 12-digit Aadhaar number')
    expect(screen.getByLabelText('Aadhaar number')).toHaveAttribute('aria-invalid', 'true')
  })
})
