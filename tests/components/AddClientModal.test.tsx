import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AddClientModal } from '@/components/AddClientModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

describe('AddClientModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(<AddClientModal onClose={onClose} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('still requires a name and DOB before Save is enabled', () => {
    render(<AddClientModal onClose={vi.fn()} />)
    expect(screen.getByText('Save')).toBeDisabled()
  })
})
