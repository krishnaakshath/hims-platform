import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState icon={Inbox} title="No items" description="Nothing matches your filters." />)
    expect(screen.getByText('No items')).toBeInTheDocument()
    expect(screen.getByText('Nothing matches your filters.')).toBeInTheDocument()
  })

  it('renders an action link when href is given', () => {
    render(<EmptyState title="None" action={{ label: 'Clear filters', href: '/list' }} />)
    expect(screen.getByRole('link', { name: 'Clear filters' })).toHaveAttribute('href', '/list')
  })

  it('renders an action button when onClick is given', () => {
    const onClick = vi.fn()
    render(<EmptyState title="None" action={{ label: 'Reset', onClick }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
