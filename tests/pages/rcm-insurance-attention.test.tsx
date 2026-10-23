import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

afterEach(() => cleanup())

function mocks(role: string) {
  vi.resetModules()
  const redirect = vi.fn(() => { throw new Error('NEXT_REDIRECT') })
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Farah', userId: 3 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined) }))
  vi.doMock('next/navigation', () => ({ redirect, notFound: vi.fn(), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
  return { redirect }
}

describe('RCM layout notice', () => {
  const load = async (role: string, ids: { rohiniId: string | null; hfrId: string | null }) => {
    mocks(role)
    vi.doMock('@/lib/queries/rcm-payers', () => ({ getHospitalIdentifiers: vi.fn(async () => ids) }))
    const { default: Layout } = await import('@/app/(dashboard)/rcm/layout')
    render(await Layout({ children: <p>page body</p> }))
  }
  it('shows the notice above the page for rcm without a link', async () => {
    await load('rcm', { rohiniId: null, hfrId: 'IN0123456789' })
    expect(screen.getByRole('alert')).toHaveTextContent('ROHINI ID is not set')
    expect(screen.getByRole('alert')).toHaveTextContent('Ask an administrator')
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('page body')).toBeInTheDocument()
  })
  it('links an admin to settings', async () => {
    await load('admin', { rohiniId: '1234567890123', hfrId: null })
    expect(screen.getByRole('link', { name: 'Set it in RCM settings' })).toHaveAttribute('href', '/rcm/settings')
  })
  it('renders nothing extra when both exist, and never gates', async () => {
    await load('rcm', { rohiniId: '1234567890123', hfrId: 'IN0123456789' })
    expect(screen.queryByRole('alert')).toBeNull()
    cleanup()
    await load('doctor', { rohiniId: null, hfrId: null })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('page body')).toBeInTheDocument()
  })
})

describe('/rcm/policies?expiring=7', () => {
  it('lists only the expiring policies it is given, by UHID', async () => {
    mocks('rcm')
    const list = vi.fn(async () => [{ policyId: 1, patientId: 'P-1', uhid: 'UH100', name: 'Asha Rao', payerName: 'Star Health', validTo: '2026-10-26' }])
    vi.doMock('@/lib/queries/coverage-attention', () => ({ listExpiringPolicies: list, EXPIRING_DAYS: 7 }))
    vi.doMock('@/lib/queries/rcm-policies', () => ({ findPatientsForRcm: vi.fn(async () => []), legacyPolicyPrefill: vi.fn(), listPatientPolicies: vi.fn() }))
    vi.doMock('@/lib/queries/rcm-payers', () => ({ listRcmPayers: vi.fn(async () => []) }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/policies/page')
    render(await Page({ searchParams: Promise.resolve({ expiring: '7' }) }))
    expect(list).toHaveBeenCalled()
    expect(screen.getByText(/Policies expiring in 7 days \(1\)/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Asha Rao' })).toHaveAttribute('href', '/rcm/policies?patientId=P-1')
    expect(screen.getByText(/UH100/)).toBeInTheDocument()
  })
  it('does not query expiring policies without the filter', async () => {
    mocks('rcm')
    const list = vi.fn(async () => [])
    vi.doMock('@/lib/queries/coverage-attention', () => ({ listExpiringPolicies: list, EXPIRING_DAYS: 7 }))
    vi.doMock('@/lib/queries/rcm-policies', () => ({ findPatientsForRcm: vi.fn(async () => []), legacyPolicyPrefill: vi.fn(), listPatientPolicies: vi.fn() }))
    vi.doMock('@/lib/queries/rcm-payers', () => ({ listRcmPayers: vi.fn(async () => []) }))
    const { default: Page } = await import('@/app/(dashboard)/rcm/policies/page')
    render(await Page({ searchParams: Promise.resolve({}) }))
    expect(list).not.toHaveBeenCalled()
  })
})
