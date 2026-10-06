import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Task 16 (RBAC hardening): the LIS Integration badge must reflect whether
// LIS_INTEGRATION_TOKEN is configured (same trimmed-nonempty rule as the
// FHIR webhook), never a hardcoded "Connected". Query modules and heavy
// children are mocked -- no DB or Redis access.

afterEach(() => { cleanup(); vi.unstubAllEnvs() })

async function renderLabs() {
  vi.resetModules()
  vi.doMock('next/navigation', () => ({ redirect: () => { throw new Error('NEXT_REDIRECT') } }))
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'admin', name: 'Test admin', userId: null })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('@/lib/queries/lab-orders', () => ({ listWorklist: vi.fn(async () => []), listPatientsWithLabOrders: vi.fn(async () => []) }))
  vi.doMock('@/lib/queries/lab-tests', () => ({ listLabTests: vi.fn(async () => []) }))
  vi.doMock('@/components/LabWorklist', () => ({ LabWorklist: () => null }))
  vi.doMock('@/components/LabsPatientReports', () => ({ LabsPatientReports: () => null }))
  vi.doMock('@/components/Tabs', () => ({ Tabs: () => null }))
  const { default: Page } = await import('@/app/(dashboard)/labs/page')
  const { render, screen } = await import('@testing-library/react')
  const { container } = render(await Page())
  return { screen, container }
}

describe('labs page LIS integration badge', () => {
  it('shows "Not configured" with a neutral, non-animated dot when the token is unset', async () => {
    vi.stubEnv('LIS_INTEGRATION_TOKEN', '')
    const { screen, container } = await renderLabs()
    expect(screen.getByText('Not configured')).toBeTruthy()
    expect(screen.queryByText(/connected/i)).toBeNull()
    expect(container.querySelector('.animate-ping')).toBeNull()
    expect(container.querySelector('.bg-success')).toBeNull()
  })

  it('treats a whitespace-only token as unset', async () => {
    vi.stubEnv('LIS_INTEGRATION_TOKEN', '   ')
    const { screen } = await renderLabs()
    expect(screen.getByText('Not configured')).toBeTruthy()
  })

  it('shows "Webhook ready" (no connection claim) when the token is set, and never renders the token', async () => {
    vi.stubEnv('LIS_INTEGRATION_TOKEN', 'super-secret-lis-token')
    const { screen, container } = await renderLabs()
    expect(screen.getByText('Webhook ready')).toBeTruthy()
    expect(screen.queryByText(/connected/i)).toBeNull()
    expect(screen.queryByText('Not configured')).toBeNull()
    expect(container.innerHTML).not.toContain('super-secret-lis-token')
  })
})
