'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MfaCodeStep } from '@/components/mfa/MfaCodeStep'
import { MfaEnrollStep } from '@/components/mfa/MfaEnrollStep'
import { FloatingField } from '@/components/auth/FloatingField'
import { PasswordField } from '@/components/auth/PasswordField'
import { SubmitButton } from '@/components/auth/SubmitButton'
import { PulseRule } from '@/components/auth/PulseRule'
import { AUTH_ALERT, AUTH_SUBTITLE, AUTH_TITLE, rise } from '@/components/auth/auth-styles'
import type { StaffPortal } from '@/components/StaffLoginForm'
import { sendJson } from '@/lib/client-fetch'

type Step =
  | { kind: 'password' }
  | { kind: 'enroll'; qrDataUrl: string; manualKey: string }
  | { kind: 'verify'; method: 'totp' | 'sms' | 'email' }

// The staff password + MFA state machine. `portal` (a department sign-in
// page) only adds an eyebrow above the heading -- the role a login grants
// always comes from the credentials, resolved server-side in POST /api/login.
export function StaffSignInForm({ portal, below }: { portal?: StaffPortal; below?: React.ReactNode }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [step, setStep] = useState<Step>({ kind: 'password' })

  function finish() {
    setDone(true)
    router.push('/')
    router.refresh()
  }

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
      finish()
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
    finish()
    return null
  }

  if (step.kind === 'enroll') {
    return (
      <div className="auth-rise" style={rise(0)}>
        <MfaEnrollStep qrDataUrl={step.qrDataUrl} manualKey={step.manualKey} onSubmit={submitMfaCode} />
      </div>
    )
  }
  if (step.kind === 'verify') {
    return (
      <div className="auth-rise" style={rise(0)}>
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
      </div>
    )
  }

  return (
    <>
      <div className="auth-rise mb-9" style={rise(1)}>
        <PulseRule />
        {portal ? <p className="mb-2 text-sm font-semibold text-primary">{portal.label}</p> : null}
        <h1 className={AUTH_TITLE}>Sign in</h1>
        <p className={AUTH_SUBTITLE}>Use your hospital email and password.</p>
      </div>
      <form onSubmit={handlePasswordSubmit} className="space-y-5">
        <div className="auth-rise" style={rise(2)}>
          <FloatingField
            id="email"
            label="Email address"
            type="email"
            required
            autoFocus
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            inputMode="email"
            placeholder="name@hospital.org"
            value={email}
            onChange={setEmail}
            invalid={!!error}
          />
        </div>
        <div className="auth-rise" style={rise(3)}>
          <PasswordField value={password} onChange={setPassword} required invalid={!!error} />
        </div>
        {error && (
          <div role="alert" className={`${AUTH_ALERT} auth-pop-menu`}>
            {error}
          </div>
        )}
        <div className="auth-rise pt-3" style={rise(4)}>
          <SubmitButton disabled={submitting || done || !email || !password} submitting={submitting} done={done} />
        </div>
      </form>
      {below ? <div className="auth-rise mt-10" style={rise(5)}>{below}</div> : null}
    </>
  )
}
