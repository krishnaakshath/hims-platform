import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { BrandingAdminPayload } from '@/lib/queries/brand-settings'
import { BrandingForm } from '@/components/settings/branding/BrandingForm'

// WL T8: the Settings > Branding form: dirty guard, save, error summary, conflict, reset, uploads.
const PAYLOAD: BrandingAdminPayload = {
  settings: {
    displayName: 'City Care Hospital', tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
    loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null,
    printHeaderText: null, printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null,
  },
  revision: 5,
  assets: [],
  defaults: { name: 'HIMS', tagline: 'Hospital information management system', supportEmail: null, accentColor: null, portalName: 'Patient portal', legalName: 'HIMS' },
  linked: { legalName: null, address: null, gstin: null, rohiniId: null, hfrId: null },
  palette: null,
}

const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const save = () => screen.getByRole('button', { name: 'Save changes' })

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('BrandingForm', () => {
  it('disables Save while pristine and enables it after an edit; Discard restores the saved values', () => {
    render(<BrandingForm initial={PAYLOAD} />)
    expect(save()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Tagline'), { target: { value: 'Care close to home' } })
    expect(save()).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.getByLabelText('Tagline')).toHaveValue('')
    expect(save()).toBeDisabled()
  })

  it('registers a beforeunload listener only while there are unsaved changes', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    render(<BrandingForm initial={PAYLOAD} />)
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(0)
    fireEvent.change(screen.getByLabelText('Tagline'), { target: { value: 'Care close to home' } })
    const added = add.mock.calls.filter(([t]) => t === 'beforeunload')
    expect(added).toHaveLength(1)
    const event = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    fireEvent.change(screen.getByLabelText('Tagline'), { target: { value: '' } })
    expect(remove.mock.calls.filter(([t, fn]) => t === 'beforeunload' && fn === added[0][1])).toHaveLength(1)
  })

  it('saves the full draft with the revision, then is pristine again', async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true, revision: 6 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Tagline'), { target: { value: 'Care close to home' } })
    fireEvent.click(save())
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings/branding')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ revision: 5, displayName: 'City Care Hospital', tagline: 'Care close to home', supportEmail: null, loginShowDepartmentList: true })
    expect(Object.keys(body)).toHaveLength(16)
    expect(save()).toBeDisabled()
  })

  it('a failed save shows an error summary that takes focus and links each field error by aria-describedby', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, {
      error: 'Invalid branding settings', details: [{ field: 'supportEmail', message: 'Enter a valid support email address' }],
    })))
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Support email'), { target: { value: 'desk@citycare.in' } })
    fireEvent.click(save())
    const summary = await screen.findByRole('alert')
    await waitFor(() => expect(summary).toHaveFocus())
    expect(summary).toHaveTextContent('Enter a valid support email address')
    expect(summary.querySelector('a[href="#brand-supportEmail"]')).not.toBeNull()
    const field = screen.getByLabelText('Support email')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    const ids = (field.getAttribute('aria-describedby') ?? '').split(' ')
    expect(ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('Enter a valid support email address')
  })

  it('validates in the browser before sending', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Support email'), { target: { value: 'not an email' } })
    fireEvent.click(save())
    const summary = await screen.findByRole('alert')
    expect(summary).toHaveTextContent('Enter a valid support email address')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('a 409 shows the reload message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(409, { error: 'Branding was changed by someone else. Reload to see their changes.', code: 'revision_conflict' })))
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Tagline'), { target: { value: 'x' } })
    fireEvent.click(save())
    expect(await screen.findByRole('alert')).toHaveTextContent('Branding was changed by someone else. Reload to see their changes.')
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('Reset requires typing RESET and posts the confirmed revision', async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true, revision: 6 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    const confirm = await screen.findByRole('button', { name: 'Reset branding' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type RESET to confirm'), { target: { value: 'reset' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Type RESET to confirm'), { target: { value: 'RESET' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings/branding/reset')
    expect(JSON.parse(String(init.body))).toEqual({ confirm: 'RESET', revision: 5 })
    await waitFor(() => expect(screen.getByLabelText('Hospital name')).toHaveValue(''))
  })

  it('uploads a logo as multipart with the variant and shows the thumbnail', async () => {
    const fetchMock = vi.fn(async () => json(201, { ok: true, asset: { kind: 'logo_light', path: '/branding/logo-light-0a1b2c3d.png', width: 400, height: 100 } }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BrandingForm initial={PAYLOAD} />)
    const file = new File(['png'], 'logo.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('Upload light logo'), { target: { files: [file] } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings/branding/assets')
    expect(init.method).toBe('POST')
    const form = init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('variant')).toBe('light')
    expect(form.get('file')).toBe(file)
    expect(await screen.findByAltText('Light logo')).toHaveAttribute('src', '/branding/logo-light-0a1b2c3d.png')
  })

  it('shows the plain-language message for an unsafe SVG', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(422, { error: 'This SVG cannot be used.', code: 'svg_unsafe' })))
    render(<BrandingForm initial={PAYLOAD} />)
    fireEvent.change(screen.getByLabelText('Upload app icon'), { target: { files: [new File(['<svg/>'], 'i.svg', { type: 'image/svg+xml' })] } })
    expect(await screen.findByText('This SVG contains scripts or external links. Export a plain SVG or PNG.')).toBeInTheDocument()
  })

  it('removes an uploaded logo', async () => {
    const fetchMock = vi.fn(async () => json(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    render(<BrandingForm initial={{ ...PAYLOAD, assets: [{ kind: 'logo_dark', path: '/branding/logo-dark-aa.png', width: 400, height: 100, source: 'upload' }] }} />)
    expect(screen.getByAltText('Dark logo')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove dark logo' }))
    await waitFor(() => expect(screen.queryByAltText('Dark logo')).toBeNull())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/settings/branding/assets?variant=dark')
    expect(init.method).toBe('DELETE')
  })
})
