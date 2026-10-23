import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react'
import type { BrandingAdminPayload } from '@/lib/queries/brand-settings'

// WL T8: the Settings > Branding live preview. Static markup only: the sign-in pane mirrors the
// ID-badge login (ShellChart) without mounting it or any of its animated parts (lane ruling R2).
const shellChart = vi.hoisted(() => vi.fn(() => null))
vi.mock('@/components/auth/ShellChart', () => ({ ShellChart: shellChart }))

import { BrandPreview, EMPTY_DRAFT, type BrandDraft } from '@/components/settings/branding/BrandPreview'
import { BrandingForm } from '@/components/settings/branding/BrandingForm'

const PAYLOAD: BrandingAdminPayload = {
  settings: {
    displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: 'Care first, always.', loginQuoteAttribution: 'Dr. A. Rao', loginShowDepartmentList: true, portalName: null,
    printHeaderText: null, printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null,
  },
  revision: 2,
  assets: [],
  defaults: { name: 'HIMS', tagline: 'Hospital information management system', supportEmail: null, accentColor: null, portalName: 'Patient portal', legalName: 'HIMS' },
  linked: { legalName: null, address: null, gstin: null, rohiniId: null, hfrId: null },
  palette: null,
}

const pane = (key: string) => document.querySelector(`[data-pane="${key}"]`) as HTMLElement
const previewRoot = () => screen.getByLabelText('Preview')

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('BrandPreview', () => {
  it('typing a name updates the text in all four panes', () => {
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Hospital name'), { target: { value: 'Sunrise Hospital' } })
    for (const key of ['signin', 'nav', 'slip', 'email']) {
      expect(within(pane(key)).getAllByText(/Sunrise Hospital/).length, key).toBeGreaterThan(0)
    }
  })

  it('labels the four panes', () => {
    render(<BrandPreview draft={EMPTY_DRAFT} assets={{}} linked={PAYLOAD.linked} />)
    for (const label of ['Sign-in page', 'Navigation', 'Printed slip', 'Email']) expect(within(previewRoot()).getByText(label)).toBeInTheDocument()
  })

  it('shows the quote and attribution in the sign-in pane', () => {
    render(<BrandingForm initial={PAYLOAD} />)
    expect(within(pane('signin')).getByText(/Care first, always\./)).toBeInTheDocument()
    expect(within(pane('signin')).getByText(/Dr\. A\. Rao/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Quote'), { target: { value: 'Every patient, every time.' } })
    expect(within(pane('signin')).getByText(/Every patient, every time\./)).toBeInTheDocument()
  })

  it('hides "Department sign-in" when the department list is off', () => {
    const draft: BrandDraft = { ...EMPTY_DRAFT, loginShowDepartmentList: true }
    const { rerender } = render(<BrandPreview draft={draft} assets={{}} linked={PAYLOAD.linked} />)
    expect(within(pane('signin')).getByText('Department sign-in')).toBeInTheDocument()
    rerender(<BrandPreview draft={{ ...draft, loginShowDepartmentList: false }} assets={{}} linked={PAYLOAD.linked} />)
    expect(within(pane('signin')).queryByText('Department sign-in')).toBeNull()
  })

  it('the toggle in the form drives the department line', () => {
    render(<BrandingForm initial={PAYLOAD} />)
    expect(within(pane('signin')).getByText('Department sign-in')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Show department sign-in links'))
    expect(within(pane('signin')).queryByText('Department sign-in')).toBeNull()
  })

  it('#ffe680 shows "Adjusted for readability" with the adjusted hex, and the preview uses the adjusted primary', async () => {
    const { deriveAccentPalette } = await import('@/lib/brand-color')
    const palette = deriveAccentPalette('#ffe680')
    expect(palette.adjustedLight).toBe(true)
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Accent colour (hex)'), { target: { value: '#ffe680' } })
    expect(screen.getByText(/Adjusted for readability/)).toHaveTextContent(palette.light.primary)
    expect(previewRoot().style.getPropertyValue('--primary')).toBe(palette.light.primary)
    expect(previewRoot().style.getPropertyValue('--brand')).toBe('#ffe680')
  })

  it('an invalid hex shows a field error and the preview keeps the last valid colour', () => {
    render(<BrandingForm initial={PAYLOAD} />)
    const hex = screen.getByLabelText('Accent colour (hex)')
    fireEvent.change(hex, { target: { value: '#0f766e' } })
    const kept = previewRoot().style.getPropertyValue('--primary')
    expect(kept).toMatch(/^#[0-9a-f]{6}$/)
    fireEvent.change(hex, { target: { value: '#12' } })
    expect(hex).toHaveAttribute('aria-invalid', 'true')
    const describedBy = hex.getAttribute('aria-describedby') ?? ''
    const error = describedBy.split(' ').map((id) => document.getElementById(id)).find((el) => el?.textContent?.includes('#rgb or #rrggbb'))
    expect(error).toBeTruthy()
    expect(previewRoot().style.getPropertyValue('--primary')).toBe(kept)
  })

  it('keeps the colour picker and hex field in sync', () => {
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Accent colour'), { target: { value: '#1d4ed8' } })
    expect(screen.getByLabelText('Accent colour (hex)')).toHaveValue('#1d4ed8')
    fireEvent.change(screen.getByLabelText('Accent colour (hex)'), { target: { value: '#B91C1C' } })
    expect(screen.getByLabelText('Accent colour')).toHaveValue('#b91c1c')
  })

  it('renders markup in the footer as literal text', () => {
    render(<BrandPreview draft={{ ...EMPTY_DRAFT, printFooterText: '<b>x</b>' }} assets={{}} linked={PAYLOAD.linked} />)
    expect(screen.getByText('<b>x</b>')).toBeInTheDocument()
    expect(previewRoot().querySelector('b')).toBeNull()
  })

  it('the preview root is inert and labelled Preview', () => {
    render(<BrandPreview draft={EMPTY_DRAFT} assets={{}} linked={PAYLOAD.linked} />)
    expect(previewRoot()).toHaveAttribute('inert')
    expect(previewRoot()).toHaveAttribute('aria-label', 'Preview')
  })

  it('never mounts the animated sign-in shell or any animated part', () => {
    render(<BrandPreview draft={EMPTY_DRAFT} assets={{}} linked={PAYLOAD.linked} />)
    expect(shellChart).not.toHaveBeenCalled()
    expect(previewRoot().querySelector('.auth-trace, .auth-draw, .auth-rise, .auth-sweep, canvas')).toBeNull()
  })

  it('shows the uploaded light logo over the logo web address', () => {
    const draft: BrandDraft = { ...EMPTY_DRAFT, displayName: 'Sunrise Hospital', logoUrl: 'https://cdn.example.in/logo.png' }
    const { rerender } = render(<BrandPreview draft={draft} assets={{}} linked={PAYLOAD.linked} />)
    expect(within(pane('signin')).getByRole('img', { name: 'Sunrise Hospital' })).toHaveAttribute('src', 'https://cdn.example.in/logo.png')
    rerender(<BrandPreview draft={draft} assets={{ light: '/branding/logo-light-abc.png' }} linked={PAYLOAD.linked} />)
    expect(within(pane('signin')).getByRole('img', { name: 'Sunrise Hospital' })).toHaveAttribute('src', '/branding/logo-light-abc.png')
  })
})
