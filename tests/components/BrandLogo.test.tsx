import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BrandLogo } from '@/components/BrandLogo'
import { BrandProvider } from '@/components/BrandProvider'

describe('BrandLogo', () => {
  it('renders the default brand name as a text wordmark without a provider', () => {
    render(<BrandLogo />)
    expect(screen.getByText('HIMS')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('renders the provided brand name as text when no logo is configured', () => {
    render(<BrandProvider brand={{ name: 'Acme Health', logoUrl: null }}><BrandLogo className="text-xl" /></BrandProvider>)
    const el = screen.getByText('Acme Health')
    expect(el.tagName).toBe('SPAN')
    expect(el).toHaveClass('text-xl')
  })

  it('renders an <img> with the brand name as alt text when a logo URL is set', () => {
    render(<BrandProvider brand={{ name: 'Acme Health', logoUrl: 'https://cdn.acme.example/logo.svg' }}><BrandLogo className="text-xl" /></BrandProvider>)
    const img = screen.getByRole('img', { name: 'Acme Health' })
    expect(img).toHaveAttribute('src', 'https://cdn.acme.example/logo.svg')
    expect(img).toHaveClass('text-xl')
  })

  it('renders HTML-looking brand names as literal text', () => {
    const { container } = render(<BrandProvider brand={{ name: '<b>Acme</b>', logoUrl: null }}><BrandLogo /></BrandProvider>)
    expect(screen.getByText('<b>Acme</b>')).toBeInTheDocument()
    expect(container.querySelector('b')).toBeNull()
  })

  it('renders the dark logo only under the dark theme, the light one otherwise (WL T4)', () => {
    render(<BrandProvider brand={{ name: 'Acme Health', logoUrl: '/branding/logo-light-aaaaaaaaaaaaaaaa.png', logoDarkUrl: '/branding/logo-dark-bbbbbbbbbbbbbbbb.png' }}><BrandLogo /></BrandProvider>)
    const imgs = screen.getAllByRole('img', { name: 'Acme Health' })
    expect(imgs).toHaveLength(2)
    expect(imgs[0]).toHaveAttribute('src', '/branding/logo-light-aaaaaaaaaaaaaaaa.png')
    expect(imgs[0]).toHaveClass('dark:hidden')
    expect(imgs[1]).toHaveAttribute('src', '/branding/logo-dark-bbbbbbbbbbbbbbbb.png')
    expect(imgs[1]).toHaveClass('hidden', 'dark:inline')
  })

  it('uses the light logo in both themes when no dark logo is stored', () => {
    render(<BrandProvider brand={{ name: 'Acme Health', logoUrl: '/branding/logo-light-aaaaaaaaaaaaaaaa.png', logoDarkUrl: null }}><BrandLogo /></BrandProvider>)
    const img = screen.getByRole('img', { name: 'Acme Health' })
    expect(img).not.toHaveClass('dark:hidden')
  })
})
