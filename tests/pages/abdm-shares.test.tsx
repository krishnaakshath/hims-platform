import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { PAGE_GATES } from './page-gates-harness'
import { NAV_ITEMS } from '@/components/LeftNav'

afterEach(() => cleanup())

const ROW = {
  id: 7, tokenNumber: 3, counterId: 'C1', name: 'Asha Rao', gender: 'F', yearOfBirth: 1990, abhaMasked: 'XX-XXXX-XXXX-9012', abhaAddress: 'asha.rao@sbx',
  receivedAt: '2099-03-01T05:00:00.000Z', isMock: false, existingPatientId: null, existingPatientUhid: null,
}

async function renderPage(rows: unknown[], setup: { state: string; qrUrlTemplate: string | null }) {
  vi.resetModules()
  const logAudit = vi.fn(async () => undefined)
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role: 'frontdesk', name: 'Desk', userId: 1 })) }))
  vi.doMock('@/lib/audit', () => ({ logAudit }))
  vi.doMock('next/navigation', () => ({ redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }), useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
  vi.doMock('@/lib/queries/abdm-profile-shares', () => ({ listPendingShares: vi.fn(async () => rows), scanShareSetup: () => setup }))
  const { default: Page } = await import('@/app/(dashboard)/front-desk/abdm-shares/page')
  const { render } = await import('@testing-library/react')
  render(await Page())
  return logAudit
}

describe('/front-desk/abdm-shares', () => {
  it('is gated to admin and frontdesk, matching the nav', () => {
    expect(PAGE_GATES.find((g) => g.route === '/front-desk/abdm-shares')!.allowed).toEqual(['admin', 'frontdesk'])
    expect(NAV_ITEMS.find((n) => n.href === '/front-desk/abdm-shares')!.roles).toEqual(['admin', 'frontdesk'])
  })
  it('shows the token and the masked ABHA only, and audits the view', async () => {
    const logAudit = await renderPage([ROW], { state: 'configured', qrUrlTemplate: 'https://phrsbx.abdm.gov.in/share-profile?hip-id=HFR-1&counter-id=<COUNTER>' })
    const { screen } = await import('@testing-library/react')
    expect(screen.getByText('C1-3')).toBeInTheDocument()
    expect(screen.getByText('XX-XXXX-XXXX-9012')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\d{2}-\d{4}-\d{4}-\d{4}/)
    expect(screen.getByRole('button', { name: 'Register' })).toBeInTheDocument()
    expect(screen.getByText(/hip-id=HFR-1/)).toBeInTheDocument()
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'abdm: viewed profile share queue', null)
  })
  it('offers Link for a share matching an existing patient and says when Scan & Share is not configured', async () => {
    await renderPage([{ ...ROW, existingPatientId: 'RD-1', existingPatientUhid: 'UH-0001' }], { state: 'not_configured', qrUrlTemplate: null })
    const { screen } = await import('@testing-library/react')
    expect(screen.getByRole('button', { name: 'Link to UH-0001' })).toBeInTheDocument()
    expect(screen.getByText(/Scan & Share is not configured/)).toBeInTheDocument()
  })
})
