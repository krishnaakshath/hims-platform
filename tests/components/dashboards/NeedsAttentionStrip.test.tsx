import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { NeedsAttentionStrip } from '@/components/dashboards/NeedsAttentionStrip'
import type { AttentionItem } from '@/lib/queries/needs-attention'
import { deadLinks } from '../../pages/dashboard-link-gates'

const ITEMS: AttentionItem[] = [
  { id: 'overdue_data_requests', label: 'Data requests past the due date', count: 2, href: '/governance/data-requests', tone: 'danger' },
  { id: 'expiring_credentials', label: 'Staff credentials expired or expiring in 30 days', count: 3, href: '/staff', tone: 'warning' },
]

describe('NeedsAttentionStrip', () => {
  it('renders nothing at all (not an empty box) when there are no items', () => {
    const { container } = render(<NeedsAttentionStrip items={[]} />)
    expect(container.innerHTML).toBe('')
    expect(screen.queryByText(/needs attention/i)).toBeNull()
  })

  it('renders each item as a link with its count and label, in the order given', () => {
    const { container } = render(<NeedsAttentionStrip items={ITEMS} />)
    expect(screen.getByRole('region', { name: 'Needs attention' })).toBeInTheDocument()
    const links = [...container.querySelectorAll('a[data-attention]')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/governance/data-requests', '/staff'])
    expect(links[0].textContent).toContain('2')
    expect(links[0].textContent).toContain('Data requests past the due date')
    expect(links[1].textContent).toContain('3')
    expect(deadLinks(container, 'admin')).toEqual([])
  })
})
