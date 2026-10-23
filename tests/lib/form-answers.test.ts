import { describe, it, expect } from 'vitest'
import { formatAnswerDisplay } from '@/lib/form-answers'

describe('formatAnswerDisplay', () => {
  it('shows an em dash for an unanswered text question', () => {
    expect(formatAnswerDisplay({ id: 'q1', label: 'Name', type: 'text' }, undefined)).toBe('—')
    expect(formatAnswerDisplay({ id: 'q1', label: 'Name', type: 'text' }, '')).toBe('—')
  })

  it('passes through a plain text/date answer', () => {
    expect(formatAnswerDisplay({ id: 'q1', label: 'DOB', type: 'date' }, '1990-01-01')).toBe('1990-01-01')
  })

  it('renders checkbox answers as Yes/No rather than the raw true/false string', () => {
    const question = { id: 'q1', label: 'Consent', type: 'checkbox' as const }
    expect(formatAnswerDisplay(question, 'true')).toBe('Yes')
    expect(formatAnswerDisplay(question, 'false')).toBe('No')
    expect(formatAnswerDisplay(question, undefined)).toBe('—')
  })

  it('surfaces the selected option text for a select question', () => {
    const question = { id: 'q1', label: 'Severity', type: 'select' as const, options: ['Mild', 'Moderate', 'Severe'] }
    expect(formatAnswerDisplay(question, 'Moderate')).toBe('Moderate')
  })
})

// WS7 T1: display values for the question model v2 types.
describe('formatAnswerDisplay (question model v2)', () => {
  it('passes number and phone answers through', () => {
    expect(formatAnswerDisplay({ id: 'w', label: 'Weight', type: 'number' }, '72.5')).toBe('72.5')
    expect(formatAnswerDisplay({ id: 'p', label: 'Mobile', type: 'phone' }, '+919845012345')).toBe('+919845012345')
  })

  it('shows a file answer as an uploaded document, never the raw reference', () => {
    expect(formatAnswerDisplay({ id: 'f', label: 'Referral letter', type: 'file' }, 'doc:42')).toBe('Document uploaded')
    expect(formatAnswerDisplay({ id: 'f', label: 'Referral letter', type: 'file' }, undefined)).toBe('—')
  })

  it('shows a signature as the typed name', () => {
    expect(formatAnswerDisplay({ id: 's', label: 'Signature', type: 'signature' }, 'Ananya Rao')).toBe('Signed as Ananya Rao')
  })

  it('a section never has an answer', () => {
    expect(formatAnswerDisplay({ id: 'h', label: 'History', type: 'section' }, 'x')).toBe('—')
  })
})
