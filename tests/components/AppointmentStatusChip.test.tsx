import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AppointmentStatusChip } from '@/components/AppointmentStatusChip'

describe('AppointmentStatusChip', () => {
  it('renders the label text for every status', () => {
    const { rerender } = render(<AppointmentStatusChip status="scheduled" />)
    expect(screen.getByText(/scheduled/i)).toBeInTheDocument()
    rerender(<AppointmentStatusChip status="completed" />)
    expect(screen.getByText(/completed/i)).toBeInTheDocument()
    rerender(<AppointmentStatusChip status="cancelled" />)
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument()
    rerender(<AppointmentStatusChip status="no_show" />)
    expect(screen.getByText(/no-show/i)).toBeInTheDocument()
  })

  it('pairs the label with a colored dot, never a Lucide icon glyph', () => {
    const { container } = render(<AppointmentStatusChip status="no_show" />)
    expect(container.querySelector('svg')).not.toBeInTheDocument()
    expect(container.querySelector('span[aria-hidden="true"]')).toBeInTheDocument()
  })
})
