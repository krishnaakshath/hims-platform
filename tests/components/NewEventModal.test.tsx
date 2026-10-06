import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewEventModal } from '@/components/NewEventModal'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

describe('NewEventModal', () => {
  it('renders as an accessible dialog that closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <NewEventModal
        patients={[{ id: 'RD-0001', name: 'Test Patient' }]}
        providers={[{ id: 1, name: 'Dr. Test' }]}
        defaultDate="2026-09-25"
        onClose={onClose}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('caps the visit reason input at 140 characters', () => {
    render(
      <NewEventModal
        patients={[{ id: 'RD-0001', name: 'Test Patient' }]}
        providers={[{ id: 1, name: 'Dr. Test' }]}
        defaultDate="2026-09-25"
        onClose={vi.fn()}
      />
    )
    expect(screen.getByPlaceholderText('Visit reason')).toHaveAttribute('maxLength', '140')
  })
})
