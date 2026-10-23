import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QuestionConditionEditor } from '@/components/forms/QuestionConditionEditor'
import type { FormQuestion } from '@/lib/forms/question-model'

const q = (id: string, type: FormQuestion['type'], label: string, extra: Partial<FormQuestion> = {}): FormQuestion =>
  ({ id, label, type, hipaaSensitive: false, required: false, ...extra })

const QUESTIONS: FormQuestion[] = [
  q('s1', 'section', 'About you'),
  q('q1', 'text', 'Full name'),
  q('q2', 'select', 'Any allergies?', { options: ['Yes', 'No'] }),
  q('q3', 'checkbox', 'Do you smoke?'),
  q('q4', 'textarea', 'Which allergies?'),
  q('q5', 'select', 'Later choice', { options: ['A', 'B'] }),
]

describe('QuestionConditionEditor', () => {
  it('lists only earlier select and checkbox questions, never sections or later ones', () => {
    const onChange = vi.fn()
    render(<QuestionConditionEditor questions={QUESTIONS} index={4} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show only if…' }))
    // Starts on the first eligible trigger and its first option.
    expect(onChange).toHaveBeenCalledWith({ questionId: 'q2', equals: 'Yes' })
  })

  it('names triggers by question number and offers their English options', () => {
    const onChange = vi.fn()
    render(<QuestionConditionEditor questions={QUESTIONS} index={4} value={{ questionId: 'q2', equals: 'Yes' }} onChange={onChange} />)
    const trigger = screen.getByLabelText('Show only if question') as HTMLSelectElement
    expect([...trigger.options].map((o) => o.textContent)).toEqual(['Q2. Any allergies?', 'Q3. Do you smoke?'])
    const answer = screen.getByLabelText('Show only if answer') as HTMLSelectElement
    expect([...answer.options].map((o) => o.value)).toEqual(['Yes', 'No'])
    fireEvent.change(answer, { target: { value: 'No' } })
    expect(onChange).toHaveBeenLastCalledWith({ questionId: 'q2', equals: 'No' })
  })

  it('offers Ticked / Not ticked for a checkbox trigger and resets the answer when the trigger changes', () => {
    const onChange = vi.fn()
    const { rerender } = render(<QuestionConditionEditor questions={QUESTIONS} index={4} value={{ questionId: 'q2', equals: 'Yes' }} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Show only if question'), { target: { value: 'q3' } })
    expect(onChange).toHaveBeenLastCalledWith({ questionId: 'q3', equals: 'true' })
    rerender(<QuestionConditionEditor questions={QUESTIONS} index={4} value={{ questionId: 'q3', equals: 'true' }} onChange={onChange} />)
    const answer = screen.getByLabelText('Show only if answer') as HTMLSelectElement
    expect([...answer.options].map((o) => [o.value, o.textContent])).toEqual([['true', 'Ticked'], ['false', 'Not ticked']])
  })

  it('removes the condition', () => {
    const onChange = vi.fn()
    render(<QuestionConditionEditor questions={QUESTIONS} index={4} value={{ questionId: 'q2', equals: 'Yes' }} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove condition' }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('offers nothing when no earlier question can be a trigger', () => {
    render(<QuestionConditionEditor questions={QUESTIONS} index={2} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Show only if…' })).not.toBeInTheDocument()
  })
})
