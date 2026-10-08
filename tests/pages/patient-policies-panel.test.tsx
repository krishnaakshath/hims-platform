import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import type { Role } from '@/lib/auth'

afterEach(() => cleanup())

async function renderPolicies(role: Role, patientId = 'P-1') {
  vi.resetModules()
  const logAudit = vi.fn(async () => undefined)
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Tester', userId: 1 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
  vi.doMock('@/lib/queries/rcm-policies', () => ({
    findPatientsForRcm: vi.fn(async () => [{ id: 'P-1', name: 'Asha Rao', uhid: 'UH1', gender: 'female', ageYears: 40 }]),
    listPatientPolicies: vi.fn(async () => []), legacyPolicyPrefill: vi.fn(async () => null),
  }))
  vi.doMock('@/lib/queries/rcm-payers', () => ({ listRcmPayers: vi.fn(async () => []) }))
  const { default: Page } = await import('@/app/(dashboard)/rcm/policies/page')
  const { render, screen } = await import('@testing-library/react')
  render(await Page({ searchParams: Promise.resolve({ patientId }) }))
  return { screen, logAudit }
}

describe('/rcm/policies', () => {
  it('rcm sees an editable panel and the view is audited with the patient id', async () => {
    const { screen, logAudit } = await renderPolicies('rcm')
    expect(screen.getByRole('button', { name: 'Add policy' })).toBeInTheDocument()
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ role: 'rcm' }), 'rcm: viewed patient policies', 'P-1')
  })
  it('pi is redirected before any query', async () => {
    await expect(renderPolicies('pi')).rejects.toThrow('NEXT_REDIRECT')
  })
})
