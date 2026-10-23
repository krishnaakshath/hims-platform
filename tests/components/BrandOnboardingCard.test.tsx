// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

import { BrandOnboardingCard } from '@/components/BrandOnboardingCard'

const status = {
  items: [
    { key: 'name' as const, done: true, href: '/settings/branding#identity' },
    { key: 'logo' as const, done: true, href: '/settings/branding#logo' },
    { key: 'colour' as const, done: false, href: '/settings/branding#colour' },
    { key: 'contact' as const, done: false, href: '/settings/branding#contact' },
    { key: 'signin' as const, done: false, href: '/login' },
  ],
  complete: false, dismissed: false,
}

describe('BrandOnboardingCard', () => {
  beforeEach(() => {
    refresh.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })

  it('shows heading, progress text and a link per open item', () => {
    render(<BrandOnboardingCard status={status} />)
    expect(screen.getByText("Set up your hospital's branding")).toBeTruthy()
    expect(screen.getByText('2 of 5 done')).toBeTruthy()
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['/settings/branding#colour', '/settings/branding#contact', '/login'])
    const login = screen.getAllByRole('link').find((a) => a.getAttribute('href') === '/login')!
    expect(login.getAttribute('target')).toBe('_blank')
    expect(login.getAttribute('rel')).toBe('noopener')
    expect(screen.getByText(/Open it in a private window/)).toBeTruthy()
  })

  it('dismiss posts the action and refreshes', async () => {
    render(<BrandOnboardingCard status={status} />)
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/settings/branding/onboarding')
    expect(JSON.parse(init.body)).toEqual({ action: 'dismiss' })
  })

  it('tested sign-in posts test_signin_done', async () => {
    render(<BrandOnboardingCard status={status} />)
    fireEvent.click(screen.getByRole('button', { name: /tested the sign-in page/i }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(JSON.parse(init.body)).toEqual({ action: 'test_signin_done' })
  })
})
