// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const getSession = vi.fn()
const getBrandOnboarding = vi.fn()
vi.mock('@/lib/auth', () => ({ getSession: (...a: unknown[]) => getSession(...a) }))
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/brand-server', () => ({ getBrandOnboarding: (...a: unknown[]) => getBrandOnboarding(...a) }))
vi.mock('@/lib/nav-badges', () => ({ getNavBadges: async () => ({}) }))
vi.mock('@/components/TopBanner', () => ({ TopBanner: () => null }))
vi.mock('@/components/LeftNav', () => ({ LeftNav: () => null }))
vi.mock('@/components/SessionTimeoutWarning', () => ({ SessionTimeoutWarning: () => null }))

import DashboardLayout from '@/app/(dashboard)/layout'

const incomplete = {
  items: [
    { key: 'name', done: false, href: '/settings/branding#identity' },
    { key: 'logo', done: false, href: '/settings/branding#logo' },
    { key: 'colour', done: false, href: '/settings/branding#colour' },
    { key: 'contact', done: false, href: '/settings/branding#contact' },
    { key: 'signin', done: false, href: '/login' },
  ],
  complete: false, dismissed: false,
}

async function renderLayout() {
  render(await DashboardLayout({ children: <p>page body</p> }))
}
const HEADING = "Set up your hospital's branding"

describe('dashboard layout onboarding card', () => {
  beforeEach(() => { getSession.mockReset(); getBrandOnboarding.mockReset() })

  it('admin with an incomplete status sees the card', async () => {
    getSession.mockResolvedValue({ role: 'admin', name: 'A' })
    getBrandOnboarding.mockResolvedValue(incomplete)
    await renderLayout()
    expect(screen.getByText(HEADING)).toBeTruthy()
    expect(screen.getByText('page body')).toBeTruthy()
  })

  it.each(['pi', 'frontdesk', 'billing'])('%s never sees it and the loader is not called', async (role) => {
    getSession.mockResolvedValue({ role, name: 'U' })
    getBrandOnboarding.mockResolvedValue(incomplete)
    await renderLayout()
    expect(screen.queryByText(HEADING)).toBeNull()
    expect(getBrandOnboarding).not.toHaveBeenCalled()
    expect(screen.getByText('page body')).toBeTruthy()
  })

  it('complete or dismissed shows nothing', async () => {
    getSession.mockResolvedValue({ role: 'admin', name: 'A' })
    getBrandOnboarding.mockResolvedValue({ ...incomplete, complete: true })
    await renderLayout()
    expect(screen.queryByText(HEADING)).toBeNull()
    getBrandOnboarding.mockResolvedValue({ ...incomplete, dismissed: true })
    document.body.innerHTML = ''
    await renderLayout()
    expect(screen.queryByText(HEADING)).toBeNull()
  })

  it('a throwing loader renders nothing and the page still renders', async () => {
    getSession.mockResolvedValue({ role: 'admin', name: 'A' })
    getBrandOnboarding.mockRejectedValue(new Error('db down'))
    await renderLayout()
    expect(screen.queryByText(HEADING)).toBeNull()
    expect(screen.getByText('page body')).toBeTruthy()
  })
})
