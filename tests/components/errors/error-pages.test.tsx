// Wave H P2-08: app-level error.tsx / global-error.tsx / not-found.tsx and the
// per-segment boundaries. Brand-neutral; a "Try again" (retry) and a home
// action; the error message and stack are never rendered -- only the digest id.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { renderToStaticMarkup } from 'react-dom/server'
import AppError from '@/app/error'
import GlobalError from '@/app/global-error'
import NotFound from '@/app/not-found'
import DashboardError from '@/app/(dashboard)/error'
import PortalError from '@/app/patient-portal/error'
import { brand } from '@/lib/brand'

const secret = Object.assign(new Error('relation "patients" does not exist at /srv/app.js:12'), { digest: 'abc123' })

describe.each([
  ['app/error', AppError, '/'],
  ['(dashboard)/error', DashboardError, '/'],
  ['patient-portal/error', PortalError, '/patient-portal'],
] as const)('%s', (_name, Boundary, home) => {
  it('shows a fixed message, the digest only, Try again and a home link', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const retry = vi.fn()
    render(<Boundary error={secret} retry={retry} reset={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i)
    expect(document.body.textContent).toContain('abc123')
    expect(document.body.textContent).not.toContain('relation')
    expect(document.body.textContent).not.toContain('/srv/app.js')
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: /go to (dashboard|home)/i })).toHaveAttribute('href', home)
  })

  it('omits the reference line when there is no digest', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Boundary error={new Error('client boom')} retry={vi.fn()} reset={vi.fn()} />)
    expect(document.body.textContent).not.toMatch(/reference/i)
    expect(document.body.textContent).not.toContain('client boom')
  })
})

describe('global-error', () => {
  it('renders its own html/body, no brand, no message, digest only', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const html = renderToStaticMarkup(<GlobalError error={secret} retry={vi.fn()} reset={vi.fn()} />)
    expect(html.startsWith('<html')).toBe(true)
    expect(html).toContain('<body')
    expect(html).toMatch(/Try again/)
    expect(html).toMatch(/Go to dashboard/)
    expect(html).toContain('abc123')
    expect(html).not.toContain('relation')
    if (brand.name) expect(html).not.toContain(brand.name)
  })
})

describe('not-found', () => {
  it('says the page was not found and links home, brand-neutral', () => {
    render(<NotFound />)
    expect(screen.getByRole('heading', { name: /page not found/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /go to dashboard/i })).toHaveAttribute('href', '/')
    if (brand.name) expect(document.body.textContent).not.toContain(brand.name)
  })
})
