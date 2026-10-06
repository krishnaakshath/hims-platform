'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

const WARN_AFTER_MS = 10 * 60 * 1000
const LOGOUT_AFTER_MS = 12 * 60 * 1000

export function PatientPortalSessionTimeoutWarning() {
  const [showWarning, setShowWarning] = useState(false)
  const router = useRouter()
  const warnTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const logoutTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const reset = useCallback(() => {
    clearTimeout(warnTimer.current)
    clearTimeout(logoutTimer.current)
    setShowWarning(false)
    warnTimer.current = setTimeout(() => setShowWarning(true), WARN_AFTER_MS)
    logoutTimer.current = setTimeout(() => {
      fetch('/api/patient-portal/logout', { method: 'POST' }).finally(() => router.push('/patient-portal/login'))
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
        <p className="mb-2 font-semibold text-foreground">You&apos;ll be signed out soon</p>
        <p className="mb-4 text-sm text-muted-foreground">For your privacy, inactive sessions end automatically.</p>
        <button onClick={reset} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground transition-opacity hover:opacity-90">
          Stay signed in
        </button>
      </div>
    </div>
  )
}
