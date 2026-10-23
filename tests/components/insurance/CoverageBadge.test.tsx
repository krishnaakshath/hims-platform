import { describe, it, expect, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { CoverageBadge } from '@/components/insurance/CoverageBadge'
import { evaluateCoverage, type CoverageVerdict } from '@/lib/insurance/coverage'

afterEach(() => cleanup())

const NOW = new Date('2026-10-23T06:30:00Z')
const base: CoverageVerdict = { state: 'verified_active', severity: 'ok', label: 'Policy valid, verified 2 hours ago', detail: null, verifiedHoursAgo: 2, isMock: false, policyId: 1, verificationId: 9 }
const policy = { id: 1, status: 'active' as const, validFrom: '2025-10-23', validTo: '2026-10-22', insurerName: 'Star Health', onNhcx: true,
  limits: { sumInsuredPaise: null, balancePaise: null, copayBp: null, roomRentLimitPaise: null, icuLimitPaise: null } }

describe('CoverageBadge', () => {
  it('shows the verdict label in a status region, green when ok, with no mock label for a real answer', () => {
    render(<CoverageBadge verdict={base} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Policy valid, verified 2 hours ago')
    expect(badge).not.toHaveTextContent('Sandbox mock - not real')
    expect(badge).toHaveAttribute('data-tone', 'green')
  })

  it('adds the mock label when the verification came from the sandbox mock', () => {
    render(<CoverageBadge verdict={{ ...base, isMock: true }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Policy valid, verified 2 hours ago')
    expect(screen.getByRole('status')).toHaveTextContent('Sandbox mock - not real')
  })

  it('an expired policy reads "Policy expired on <date>" in red, even in a view context', () => {
    const verdict = evaluateCoverage({ policy, verification: null, pendingCheck: false, context: 'view', now: NOW })
    render(<CoverageBadge verdict={verdict} />)
    expect(screen.getByRole('status')).toHaveTextContent('Policy expired on 22 Oct 2026')
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'red')
  })

  it('a warning is amber and an info verdict is neutral', () => {
    const { unmount } = render(<CoverageBadge verdict={{ ...base, state: 'stale', severity: 'warn', label: 'Verification out of date' }} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'amber')
    unmount()
    render(<CoverageBadge verdict={{ ...base, state: 'unverified', severity: 'info', label: 'Not verified' }} />)
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'neutral')
  })
})
