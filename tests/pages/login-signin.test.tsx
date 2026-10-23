import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { STAFF_PORTALS } from '@/lib/staff-portals'
import { DEFAULT_LOGIN_QUOTE } from '@/lib/brand'

const push = vi.fn()
const refresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
  notFound: () => { throw new Error('notFound') },
}))

import LoginPage from '@/app/login/page'
import LoginAdminPage from '@/app/login/admin/page'
import LoginPiPage from '@/app/login/pi/page'
import PatientPortalLoginPage from '@/app/patient-portal/login/page'

// Emoji presentation characters, plus the emoji variation selector and keycap.
const EMOJI_RE = /[\p{Emoji_Presentation}\u{FE0F}\u{20E3}]/u
const TRUST_COPY_RE = /role-based|rbac|audit|two-factor|2fa|multi-factor|secure sign-in|encrypted|hipaa/i

function mockMatchMedia(reduce: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })))
}

let replaceState: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  mockMatchMedia(false)
  window.history.replaceState(null, '', '/login')
  replaceState = vi.spyOn(window.history, 'replaceState')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  push.mockClear()
  refresh.mockClear()
})

const audience = () => screen.getByRole('radiogroup', { name: 'Sign in as' })
const departmentButton = () => screen.getByRole('button', { name: 'Department sign-in' })

describe('/login', () => {
  it('opens straight on email and password under a Staff/Patient switch', () => {
    render(<LoginPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(within(audience()).getByRole('radio', { name: 'Staff' })).toHaveAttribute('aria-checked', 'true')
    expect(within(audience()).getByRole('radio', { name: 'Patient' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByLabelText('Email address')).toHaveFocus()
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
  })

  it('segmented control swaps to the patient form in place and updates the URL', () => {
    render(<LoginPage />)
    fireEvent.click(screen.getByRole('radio', { name: 'Patient' }))
    expect(screen.getByLabelText('Email address or patient ID')).toBeInTheDocument()
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/patient-portal/login')
    expect(push).not.toHaveBeenCalled()
    // Arrow keys move the selection back.
    fireEvent.keyDown(audience(), { key: 'ArrowLeft' })
    expect(screen.getByRole('radio', { name: 'Staff' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/login')
  })

  it('keeps the department list out of the markup until the menu opens', () => {
    const { container } = render(<LoginPage />)
    expect(departmentButton()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    for (const p of STAFF_PORTALS) expect(container.textContent).not.toContain(p.description)
  })

  it('lists every department sign-in page (exact label and href) once opened', () => {
    render(<LoginPage />)
    fireEvent.click(departmentButton())
    const list = screen.getByRole('listbox', { name: 'Department sign-in' })
    const options = within(list).getAllByRole('option')
    expect(options).toHaveLength(STAFF_PORTALS.length)
    STAFF_PORTALS.forEach((p, i) => {
      expect(options[i]).toHaveAttribute('data-href', `/login/${p.key}`)
      expect(options[i]).toHaveTextContent(p.label)
    })
    fireEvent.click(options[2])
    expect(push).toHaveBeenCalledWith(`/login/${STAFF_PORTALS[2].key}`)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('department menu is keyboard operable: arrows, Enter, Escape', () => {
    render(<LoginPage />)
    const button = departmentButton()
    button.focus()
    fireEvent.keyDown(button, { key: 'ArrowDown' })
    const list = screen.getByRole('listbox')
    expect(list).toHaveFocus()
    const options = within(list).getAllByRole('option')
    expect(list).toHaveAttribute('aria-activedescendant', options[0].id)
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    fireEvent.keyDown(list, { key: 'ArrowDown' })
    expect(list).toHaveAttribute('aria-activedescendant', options[2].id)
    fireEvent.keyDown(list, { key: 'End' })
    expect(list).toHaveAttribute('aria-activedescendant', options[options.length - 1].id)
    fireEvent.keyDown(list, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(button).toHaveFocus()
    expect(push).not.toHaveBeenCalled()

    fireEvent.click(button)
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Enter' })
    expect(push).toHaveBeenCalledWith(`/login/${STAFF_PORTALS[0].key}`)
  })

  it('closes the department menu on an outside click', () => {
    render(<LoginPage />)
    fireEvent.click(departmentButton())
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('anchors the department menu to its trigger and flips below when there is no room above', () => {
    render(<LoginPage />)
    const button = departmentButton()
    // Near the bottom of the viewport: room above, so it opens above.
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 700, bottom: 744, left: 40, right: 220, width: 180, height: 44, x: 40, y: 700, toJSON: () => ({}) } as DOMRect)
    fireEvent.click(button)
    let list = screen.getByRole('listbox')
    expect(list).toHaveAttribute('data-side', 'above')
    expect(list.className).toMatch(/\bleft-0\b/)
    expect(list.className).toMatch(/\bbottom-full\b/)
    expect(list.parentElement).toContainElement(button)
    fireEvent.click(button)
    // Near the top: flips below and caps its height to the space there.
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({ top: 60, bottom: 104, left: 40, right: 220, width: 180, height: 44, x: 40, y: 60, toJSON: () => ({}) } as DOMRect)
    fireEvent.click(button)
    list = screen.getByRole('listbox')
    expect(list).toHaveAttribute('data-side', 'below')
    expect(list.className).toMatch(/\btop-full\b/)
  })

  it('posts the same payload to /api/login and shows the server error', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'Invalid email or password' }), { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'dr@x.in' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/login')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ email: 'dr@x.in', password: 'pw' })
    expect(push).not.toHaveBeenCalled()
  })

  it('shows a success state and goes home when the password is enough', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'dr@x.in' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('button', { name: 'Signed in' })).toBeDisabled()
    expect(push).toHaveBeenCalledWith('/')
  })

  it('moves to the MFA code step when the server asks for it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'totp' }), { status: 200 })))
    render(<LoginPage />)
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'dr@x.in' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByLabelText('6-digit code')).toHaveAttribute('inputmode', 'numeric')
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
  })

  it('toggles password visibility with a labelled button', () => {
    render(<LoginPage />)
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('has no emoji and no RBAC/audit/two-factor trust copy; decoration is aria-hidden', () => {
    const { container } = render(<LoginPage />)
    expect(container.textContent ?? '').not.toMatch(EMOJI_RE)
    expect(container.textContent ?? '').not.toMatch(TRUST_COPY_RE)
    for (const el of container.querySelectorAll('svg')) expect(el.closest('[aria-hidden="true"]')).not.toBeNull()
    for (const el of container.querySelectorAll('[data-decorative]')) expect(el).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(departmentButton())
    expect(container.textContent ?? '').not.toMatch(EMOJI_RE)
    expect(container.textContent ?? '').not.toMatch(TRUST_COPY_RE)
  })

  it('shows the brand-configurable care quote on the panel, attributed', () => {
    render(<LoginPage />)
    const figure = screen.getByText(DEFAULT_LOGIN_QUOTE.text).closest('figure')!
    expect(figure).toHaveTextContent(DEFAULT_LOGIN_QUOTE.attribution!)
  })

  it('turns motion off when the user prefers reduced motion', async () => {
    mockMatchMedia(true)
    const { container } = render(<LoginPage />)
    await act(async () => {})
    expect(container.querySelector('[data-motion]')).toHaveAttribute('data-motion', 'reduce')
  })

  it('pauses looping motion while the tab is hidden', async () => {
    const { container } = render(<LoginPage />)
    await act(async () => {})
    expect(container.querySelector('[data-motion]')).toHaveAttribute('data-motion', 'on')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(container.querySelector('[data-motion]')).toHaveAttribute('data-motion', 'paused')
  })
})

describe('/login/[role]', () => {
  it.each([
    ['admin', LoginAdminPage, 'Admin'],
    ['pi', LoginPiPage, 'Doctor / PI'],
  ] as const)('/login/%s renders the same form with its department named', (key, Page, label) => {
    const { container } = render(<Page />)
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument()
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(container.textContent ?? '').not.toMatch(EMOJI_RE)
    fireEvent.click(departmentButton())
    const selected = screen.getByRole('option', { selected: true })
    expect(selected).toHaveAttribute('data-href', `/login/${key}`)
  })
})

describe('/patient-portal/login', () => {
  it('has Patient selected and switches to the staff form in place', () => {
    const { container } = render(<PatientPortalLoginPage />)
    expect(screen.getByRole('radio', { name: 'Patient' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: 'Department sign-in' })).not.toBeInTheDocument()
    expect(container.textContent ?? '').not.toMatch(EMOJI_RE)
    fireEvent.click(screen.getByRole('radio', { name: 'Staff' }))
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/login')
  })
})
