import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { StatusChip } from '@/components/StatusChip'

describe('StatusChip', () => {
  it('renders the label text for every verdict', () => {
    const { rerender } = render(<StatusChip status="green" />)
    expect(screen.getByText(/meets/i)).toBeInTheDocument()
    rerender(<StatusChip status="yellow" />)
    expect(screen.getByText(/needs verification/i)).toBeInTheDocument()
    rerender(<StatusChip status="red" />)
    expect(screen.getByText(/potential exclusion/i)).toBeInTheDocument()
  })

  it('pairs the label with a colored dot, never color alone, and never a Lucide icon glyph', () => {
    const { container } = render(<StatusChip status="red" />)
    // A solid color dot (a plain <span>, not an <svg> icon glyph) is the
    // only visual marker alongside the text label -- confirms no icon
    // library glyph is rendered per the redesign's "remove icons" rule.
    expect(container.querySelector('svg')).not.toBeInTheDocument()
    const dot = container.querySelector('span[aria-hidden="true"]')
    expect(dot).toBeInTheDocument()
  })
})
