'use client'
import Link from 'next/link'
import { useSyncExternalStore } from 'react'
import { ShieldCheck } from 'lucide-react'

// WS7 T7 (spec D13): patient MFA is offered, not required. Until it is on, the portal shell
// shows this nudge. "Not now" hides it for this browser session only (sessionStorage, no
// cookie), so it comes back at the next sign-in.
const DISMISS_KEY = 'hims.portal.mfaNudgeDismissed'

/** Forget a "Not now" so the next patient to sign in on this tab sees the nudge (sign-out, session timeout). */
export function clearMfaNudgeDismissal(): void {
  try { sessionStorage.removeItem(DISMISS_KEY) } catch { /* storage blocked: nothing stored */ }
}

function readDismissed(): boolean {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch { return false }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('storage', onChange)
  window.addEventListener(DISMISS_KEY, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(DISMISS_KEY, onChange)
  }
}

export function MfaNudge({ dismissible }: { dismissible: boolean }) {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => false)
  if (dismissible && dismissed) return null

  function dismiss() {
    try { sessionStorage.setItem(DISMISS_KEY, '1') } catch { /* storage blocked: hide until reload */ }
    window.dispatchEvent(new Event(DISMISS_KEY))
  }

  return (
    <div role="note" aria-label="Two-factor authentication" className="flex flex-wrap items-center gap-3 border-b border-warning/30 bg-warning/10 px-6 py-2.5 text-sm text-foreground">
      <ShieldCheck className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Recommended: add two-factor authentication to protect your health records. Signing in with a one-time code still works.
      </p>
      <Link href="/patient-portal/security" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline">
        Turn on two-factor authentication
      </Link>
      {dismissible && (
        <button type="button" onClick={dismiss} className="inline-flex min-h-11 items-center px-2 text-xs font-medium text-muted-foreground hover:text-foreground">
          Not now
        </button>
      )}
    </div>
  )
}
