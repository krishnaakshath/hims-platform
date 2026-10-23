import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import type { BrandingAdminPayload } from '@/lib/queries/brand-settings'

// WL T8: /settings/branding renders every section and the read-only billing identity for an admin;
// any other role is sent back to /settings before the payload is read.
const PAYLOAD: BrandingAdminPayload = {
  settings: {
    displayName: 'Sunrise Hospital', tagline: null, supportEmail: null, supportPhone: null, accentColor: '#0f766e', logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null,
    printHeaderText: null, printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null,
  },
  revision: 1,
  assets: [],
  defaults: { name: 'HIMS', tagline: 'Hospital information management system', supportEmail: null, accentColor: null, portalName: 'Patient portal', legalName: 'HIMS',
    loginQuote: { text: 'The very first requirement in a Hospital is that it should do the sick no harm.', attribution: 'Florence Nightingale' } },
  linked: { legalName: 'Sunrise Healthcare Pvt Ltd', address: '12 MG Road, Pune 411001', gstin: '27AABCS1234F1Z5', rohiniId: '8900080123456', hfrId: 'IN2710000123' },
  palette: null,
}

async function loadPage(role: string) {
  vi.resetModules()
  const redirect = vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`) })
  const getPayload = vi.fn(async () => PAYLOAD)
  vi.doMock('@/lib/auth', () => ({ requireSessionOrRedirect: vi.fn(async () => ({ role, name: 'Admin', userId: 1 })) }))
  vi.doMock('next/navigation', () => ({ redirect, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
  vi.doMock('@/lib/queries/brand-settings', () => ({ getBrandingAdminPayload: getPayload }))
  const { default: Page } = await import('@/app/(dashboard)/settings/branding/page')
  return { Page, redirect, getPayload }
}

afterEach(() => { cleanup(); vi.doUnmock('@/lib/auth'); vi.doUnmock('next/navigation'); vi.doUnmock('@/lib/queries/brand-settings') })

describe('/settings/branding', () => {
  it('renders every section and the linked billing identity for an admin', async () => {
    const { Page } = await loadPage('admin')
    render(await Page())
    for (const name of ['Identity', 'Contact', 'Logo and icon', 'Colour', 'Sign-in page', 'Printed documents', 'Messages']) {
      expect(screen.getByRole('heading', { name }), name).toBeInTheDocument()
    }
    for (const id of ['identity', 'contact', 'logo', 'colour', 'signin', 'print', 'messages']) expect(document.getElementById(id), id).not.toBeNull()
    const linked = screen.getByText('From Billing settings (read-only)').parentElement as HTMLElement
    for (const v of ['Sunrise Healthcare Pvt Ltd', '12 MG Road, Pune 411001', '27AABCS1234F1Z5', '8900080123456', 'IN2710000123']) {
      expect(within(linked).getByText(v)).toBeInTheDocument()
    }
    expect(within(linked).getByRole('link', { name: /Billing settings/ })).toHaveAttribute('href', '/billing/rules')
    expect(screen.getByLabelText('Hospital name')).toHaveValue('Sunrise Hospital')
    expect(screen.getByLabelText('Logo web address')).toBeInTheDocument()
  })

  it('sends a non-admin back to /settings without reading the payload', async () => {
    const { Page, redirect, getPayload } = await loadPage('pi')
    await expect(Page()).rejects.toThrow('NEXT_REDIRECT /settings')
    expect(redirect).toHaveBeenCalledWith('/settings')
    expect(getPayload).not.toHaveBeenCalled()
  })
})
