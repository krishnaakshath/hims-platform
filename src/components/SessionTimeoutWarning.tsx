'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const WARN_AFTER_MS = 10 * 60 * 1000  // 10 min idle
const LOGOUT_AFTER_MS = 12 * 60 * 1000 // 12 min idle

export function SessionTimeoutWarning() {
  const [showWarning, setShowWarning] = useState(false)
  const router = useRouter()
  const warnTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const logoutTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Shared by the idle-activity listeners AND the "Stay signed in" button —
  // both must reschedule the same timers, or clicking the button would leave
  // the original logout timer running and silently sign the user out anyway.
  const reset = useCallback(() => {
    clearTimeout(warnTimer.current)
    clearTimeout(logoutTimer.current)
    setShowWarning(false)
    warnTimer.current = setTimeout(() => setShowWarning(true), WARN_AFTER_MS)
    logoutTimer.current = setTimeout(() => {
      // The session cookie is httpOnly (can't be read or cleared from JS --
      // that was a real bug here: browsers silently ignore an attempt to
      // overwrite an httpOnly cookie via document.cookie, so this used to
      // navigate to /login while leaving the session fully valid). Go
      // through the real server-side logout endpoint instead.
      fetch('/api/logout', { method: 'POST' }).finally(() => router.push('/login'))
    }, LOGOUT_AFTER_MS)
  }, [router])

  useEffect(() => {
    reset()
    window.addEventListener('mousemove', reset)
    window.addEventListener('keydown', reset)
    return () => {
      clearTimeout(warnTimer.current)
      clearTimeout(logoutTimer.current)
      window.removeEventListener('mousemove', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [reset])

  if (!showWarning) return null

  return (
    <div role="alertdialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="rounded-lg bg-card p-6 shadow-lg">
        <p className="mb-2 font-semibold text-foreground">You'll be signed out soon</p>
        <p className="mb-4 text-sm text-muted-foreground">For patient data protection, inactive sessions end automatically.</p>
        <button onClick={reset} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90">
          Stay signed in
        </button>
      </div>
    </div>
  )
}
