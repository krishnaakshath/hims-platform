'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { BrandLogo } from '@/components/BrandLogo'
import { MfaCodeStep } from '@/components/mfa/MfaCodeStep'
import { MfaEnrollStep } from '@/components/mfa/MfaEnrollStep'
import { sendJson } from '@/lib/client-fetch'

type Step =
  | { kind: 'password' }
  | { kind: 'enroll'; qrDataUrl: string; manualKey: string }
  | { kind: 'verify'; method: 'totp' | 'sms' | 'email' }

export interface StaffPortal {
  key: string
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  /** Tailwind classes written out literally per-role (not interpolated) so the JIT compiler can see and keep them. */
  iconBg: string
  iconText: string
}

// The actual password+MFA state machine, shared by every /login/[role] page
// (and, before this, by the single /login picker) -- extracted so 7 routes
// don't each duplicate POST /api/login + POST /api/login/mfa handling. The
// portal prop is wayfinding/branding ONLY: it changes the icon, color, and
// copy shown here, never which role a login actually grants -- that always
// comes from the credentials, resolved server-side in POST /api/login.
export function StaffLoginForm({ portal }: { portal: StaffPortal }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState<Step>({ kind: 'password' })

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const result = await sendJson<{ ok?: boolean; mode?: string; qrDataUrl?: string; manualKey?: string }>('/api/login', 'POST', { email, password })
    setSubmitting(false)
    if (!result.ok) {
      // Wrong credentials stay one generic message (no account probing);
      // rate limiting, server and network failures say what happened.
      setError(result.status === 400 || result.status === 401 ? 'Invalid email or password.' : result.error)
      return
    }
    const body = result.data ?? {}
    if (body.ok) {
      router.push('/')
      router.refresh()
      return
    }
    if (body.mode === 'enroll') {
      setStep({ kind: 'enroll', qrDataUrl: body.qrDataUrl ?? '', manualKey: body.manualKey ?? '' })
    } else {
      setStep({ kind: 'verify', method: body.mode as 'totp' | 'sms' | 'email' })
    }
  }

  async function submitMfaCode(code: string): Promise<string | null> {
    const result = await sendJson('/api/login/mfa', 'POST', { code }, { passThrough: [401] })
    if (!result.ok) return result.error
    router.push('/')
    router.refresh()
    return null
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-[#fafafa] px-4 py-10 selection:bg-primary/20">
      <div className="pointer-events-none absolute left-1/2 top-0 -z-10 -translate-x-1/2 transform">
        <div className="h-[600px] w-[1000px] rounded-full bg-gradient-to-b from-primary/5 to-transparent blur-3xl" />
      </div>

      <div className="relative z-10 w-full max-w-[400px]">
        <div className="mb-8 flex flex-col items-center text-center">
          <BrandLogo className="text-3xl font-extrabold tracking-tight text-foreground" />
        </div>

        <div className="rounded-3xl border border-border/50 bg-white p-8 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.05)]">
          {step.kind === 'password' && (
            <>
              <Link
                href="/login"
                className="mb-6 flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                All portals
              </Link>
              <div className="mb-8 text-center">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sign in to</p>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">{portal.label}</h1>
                <p className="mt-2 text-sm text-muted-foreground">{portal.description}</p>
              </div>

              <form onSubmit={handlePasswordSubmit} className="space-y-5">
                <div className="space-y-1.5">
                  <label htmlFor="email" className="text-sm font-medium leading-none">
                    Email Address
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@example.com"
                    className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="password" className="text-sm font-medium leading-none">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
                {error && (
                  <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive">
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={submitting || !email || !password}
                  className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  {submitting ? (
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-r-transparent" />
                      Authenticating...
                    </div>
                  ) : (
                    'Sign in'
                  )}
                </button>
              </form>
            </>
          )}

          {step.kind === 'enroll' && (
            <MfaEnrollStep qrDataUrl={step.qrDataUrl} manualKey={step.manualKey} onSubmit={submitMfaCode} />
          )}
          {step.kind === 'verify' && (
            <MfaCodeStep
              title={step.method === 'sms' ? 'Check your phone' : step.method === 'email' ? 'Check your email' : 'Enter your code'}
              description={
                step.method === 'sms' ? 'We texted a 6-digit code to your phone. Enter it below.'
                : step.method === 'email' ? 'We emailed a 6-digit code to you. Enter it below.'
                : 'Open your authenticator app and enter the current 6-digit code.'
              }
              onSubmit={submitMfaCode}
              onBack={() => setStep({ kind: 'password' })}
            />
          )}
        </div>
      </div>
    </div>
  )
}
