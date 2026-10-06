'use client'
import { useEffect, useState } from 'react'
import type { NavBadges } from '@/components/LeftNav'

export const NAV_BADGE_REFRESH_MS = 60_000

function isNavBadges(value: unknown): value is NavBadges {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0))
}

/** A usable /api/nav-badges body: well-formed badges and an explicit
 *  `degraded: false`. Anything else (degraded, missing flag, bad shape) is
 *  treated like a failed fetch. */
function authoritativeBadges(body: unknown): NavBadges | null {
  if (typeof body !== 'object' || body === null) return null
  const { badges, degraded } = body as { badges?: unknown; degraded?: unknown }
  if (degraded !== false || !isNavBadges(badges)) return null
  return badges
}

/** Live nav counts. Next layouts don't re-render on client navigation, so the
 *  server-computed `initial` badges would go stale; this keeps them as the
 *  initial state, then refreshes from /api/nav-badges every
 *  NAV_BADGE_REFRESH_MS while the tab is visible, and immediately when the
 *  window regains focus or the document becomes visible.
 *
 *  A successful, non-degraded response is authoritative and replaces the
 *  counts: a 0 or an explicit `null` (badge intentionally suppressed, e.g.
 *  an unmatched pi) clears that pill. A failed refresh -- network error,
 *  non-2xx, bad body, or `degraded: true` (the server's fail-safe {}) --
 *  keeps the previous counts silently, so a failure never reads as 0.
 *
 *  A new `initial` from a layout re-render is merged over the current
 *  counts (the layout can't tell a degraded {} apart; its explicit nulls
 *  and numbers still apply).
 *
 *  `initial === undefined` (no server badges) disables polling entirely. */
export function useLiveNavBadges(initial: NavBadges | undefined): NavBadges | undefined {
  const [badges, setBadges] = useState(initial)
  // Adopt a fresh server value when the layout re-renders (e.g. router.refresh()).
  const [lastInitial, setLastInitial] = useState(initial)
  if (initial !== lastInitial) {
    setLastInitial(initial)
    setBadges(initial === undefined ? undefined : (prev) => ({ ...prev, ...initial }))
  }

  const enabled = initial !== undefined
  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let inFlight = false
    const controller = new AbortController()

    async function refresh() {
      if (disposed || inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const res = await fetch('/api/nav-badges', { cache: 'no-store', signal: controller.signal })
        if (!res.ok) return
        const next = authoritativeBadges(await res.json())
        if (disposed || next === null) return
        setBadges(next)
      } catch {
        // Keep the previous counts; the next tick or focus will retry.
      } finally {
        inFlight = false
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') void refresh()
    }
    function onFocus() { void refresh() }

    const interval = setInterval(() => { void refresh() }, NAV_BADGE_REFRESH_MS)
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      controller.abort()
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [enabled])

  return badges
}
