import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { LeftNav } from '@/components/LeftNav'
import { NAV_BADGE_REFRESH_MS } from '@/components/useLiveNavBadges'

vi.mock('next/navigation', () => ({ usePathname: () => '/patients' }))

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

function okResponse(badges: Record<string, number | null>, degraded = false) {
  return new Response(JSON.stringify({ badges, degraded }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let visibility: DocumentVisibilityState = 'visible'
let fetchMock: ReturnType<typeof vi.fn<FetchFn>>

function setVisibility(state: DocumentVisibilityState) {
  visibility = state
  document.dispatchEvent(new Event('visibilitychange'))
}

function myPatientsText() {
  return screen.getByRole('link', { name: /my patients/i }).textContent
}

// Let a resolved fetch + res.json() + setState settle.
async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

beforeEach(() => {
  vi.useFakeTimers()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  fetchMock = vi.fn<FetchFn>()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('LeftNav live badges', () => {
  it('refreshes every 60 seconds', () => {
    expect(NAV_BADGE_REFRESH_MS).toBe(60_000)
  })

  it('renders the server-provided badges initially, without fetching on mount', async () => {
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    await flush()
    expect(myPatientsText()).toBe('My Patients3')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('after 60s fetches /api/nav-badges (no-store) and renders the new count', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/doctor': 5 }))
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)

    await act(async () => { await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS - 1) })
    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/nav-badges')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store' })
    expect(myPatientsText()).toBe('My Patients5')
  })

  it('a count that drops to 0 hides the pill', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/doctor': 0 }))
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS) })
    await flush()
    expect(myPatientsText()).toBe('My Patients')
  })

  it('an explicit null (badge intentionally suppressed) clears the pill', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/doctor': null }))
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS) })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(myPatientsText()).toBe('My Patients')
  })

  it('a non-degraded response is authoritative: a key it omits is cleared', async () => {
    fetchMock.mockResolvedValue(okResponse({}))
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS) })
    await flush()
    expect(myPatientsText()).toBe('My Patients')
  })

  it('window focus triggers an immediate fetch', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/front-desk/assignments': 7 }))
    render(<LeftNav role="frontdesk" badges={{ '/front-desk/assignments': 1 }} />)
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('link', { name: /assignments/i }).textContent).toBe('Assignments7')
  })

  it('the document becoming visible triggers an immediate fetch', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/doctor': 9 }))
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    await act(async () => { setVisibility('hidden') })
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { setVisibility('visible') })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(myPatientsText()).toBe('My Patients9')
  })

  describe('a failed refresh keeps the previous counts (never a false 0)', () => {
    it.each([
      ['the network request rejects', () => fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))],
      ['the server answers 500', () => fetchMock.mockResolvedValue(new Response('{"error":"x"}', { status: 500 }))],
      // Even a badge-shaped body is ignored on a non-2xx status.
      ['the server answers 503 with a badge-shaped body', () => fetchMock.mockResolvedValue(new Response('{"badges":{"/doctor":0},"degraded":false}', { status: 503 }))],
      ['the session expired (401)', () => fetchMock.mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 }))],
      ['the body is not valid JSON', () => fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }))],
      ['the body has the wrong shape', () => fetchMock.mockResolvedValue(new Response('{"badges":{"/doctor":"lots"},"degraded":false}', { status: 200 }))],
      ['the server failed safe and flagged degraded', () => fetchMock.mockResolvedValue(okResponse({}, true))],
      ['degraded is true even though keys are present', () => fetchMock.mockResolvedValue(okResponse({ '/doctor': 0 }, true))],
      ['the degraded flag is missing (older server)', () => fetchMock.mockResolvedValue(new Response('{"badges":{}}', { status: 200 }))],
    ])('when %s', async (_label, arrange) => {
      arrange()
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
      await act(async () => { await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS) })
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(myPatientsText()).toBe('My Patients3')
      expect(errSpy).not.toHaveBeenCalled()
    })
  })

  it('makes no fetch while the document is hidden, and resumes when visible', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/doctor': 4 }))
    render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    await act(async () => { setVisibility('hidden') })
    await act(async () => { await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS * 5) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(myPatientsText()).toBe('My Patients3')

    await act(async () => { setVisibility('visible') })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS) })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('cleans up its interval and listeners on unmount', async () => {
    fetchMock.mockResolvedValue(okResponse({ '/doctor': 4 }))
    const { unmount } = render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    unmount()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      setVisibility('visible')
      await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS * 3)
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('adopts fresh server badges when the layout re-renders (router.refresh)', async () => {
    const { rerender } = render(<LeftNav role="pi" badges={{ '/doctor': 3 }} />)
    rerender(<LeftNav role="pi" badges={{ '/doctor': 6 }} />)
    await flush()
    expect(myPatientsText()).toBe('My Patients6')
    // A server render that failed safe to {} does not wipe the known count.
    rerender(<LeftNav role="pi" badges={{}} />)
    await flush()
    expect(myPatientsText()).toBe('My Patients6')
    // An explicit null from the server render clears it.
    rerender(<LeftNav role="pi" badges={{ '/doctor': null }} />)
    await flush()
    expect(myPatientsText()).toBe('My Patients')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not poll at all when no server badges were provided', async () => {
    render(<LeftNav role="pi" />)
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await vi.advanceTimersByTimeAsync(NAV_BADGE_REFRESH_MS * 2)
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
