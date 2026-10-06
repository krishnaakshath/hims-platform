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
