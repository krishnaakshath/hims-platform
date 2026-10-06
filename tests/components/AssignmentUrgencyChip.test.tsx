import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AssignmentUrgencyChip } from '@/components/AssignmentUrgencyChip'

describe('AssignmentUrgencyChip', () => {
  it.each([
    ['emergency', 'Emergency', 'bg-destructive'],
    ['urgent', 'Urgent', 'bg-warning'],
    ['routine', 'Routine', 'bg-muted-foreground'],
  ] as const)('%s renders a text label and an aria-hidden %s dot', (urgency, label, dotClass) => {
    render(<AssignmentUrgencyChip urgency={urgency} />)
    const text = screen.getByText(label)
    expect(text).toBeInTheDocument()
    const dot = text.querySelector('span')!
    expect(dot).toHaveAttribute('aria-hidden', 'true')
    expect(dot.className).toContain(dotClass)
  })
})
