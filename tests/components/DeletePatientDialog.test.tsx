import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DeletePatientDialog } from '@/components/DeletePatientDialog'

describe('DeletePatientDialog', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(<DeletePatientDialog target={{ id: 'RD-0001', name: 'Test Patient' }} onClose={onClose} onDeleted={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('has an accessible name, since this is the most destructive dialog in the app', () => {
    render(<DeletePatientDialog target={{ id: 'RD-0001', name: 'Test Patient' }} onClose={vi.fn()} onDeleted={vi.fn()} />)
    // getByRole with an `name` filter only matches if the dialog is wired up
    // to a real accessible name (e.g. via DialogTitle's aria-labelledby) --
    // a screen reader announcing bare "dialog" with no name would fail this.
    expect(screen.getByRole('dialog', { name: /delete patient record/i })).toBeInTheDocument()
  })

  it('renders nothing when target is null', () => {
    const { container } = render(<DeletePatientDialog target={null} onClose={vi.fn()} onDeleted={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
