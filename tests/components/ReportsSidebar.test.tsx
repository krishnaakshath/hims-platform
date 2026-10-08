import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ALL_ROLES } from '@/lib/role-policy'
import { REPORT_LEAVES } from '@/lib/reports/catalog'
import { PAGE_GATES } from '../pages/page-gates-harness'

vi.mock('next/navigation', () => ({ usePathname: () => '/reports/hospital/opd' }))

import { ReportsSidebar } from '@/components/ReportsSidebar'

// Wave I (P1-23): the sidebar shows a role exactly the report leaves whose page gate admits it.
describe('ReportsSidebar', () => {
  it.each(ALL_ROLES.map((r) => [r]))('shows %s only the reports its page gates admit', (role) => {
    const { unmount } = render(<ReportsSidebar role={role} />)
    const shown = screen.queryAllByRole('link').map((a) => a.getAttribute('href')).sort()
    const admitted = PAGE_GATES.filter((g) => g.route.startsWith('/reports/') && g.allowed.includes(role)).map((g) => g.route).sort()
    expect(shown).toEqual(admitted)
    unmount()
  })

  it('has a page gate row for every leaf, with the leaf\'s roles', () => {
    for (const leaf of REPORT_LEAVES) {
      const row = PAGE_GATES.find((g) => g.route === leaf.href)
      expect(row, leaf.href).toBeDefined()
      expect(new Set(row!.allowed), leaf.href).toEqual(new Set(leaf.roles))
    }
  })

  it('marks the current report', () => {
    render(<ReportsSidebar role="admin" />)
    expect(screen.getByRole('link', { name: 'OPD statistics' })).toHaveAttribute('aria-current', 'page')
  })
})
