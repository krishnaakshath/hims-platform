'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MfaCodeStep } from '@/components/mfa/MfaCodeStep'
import { MfaEnrollStep } from '@/components/mfa/MfaEnrollStep'
import { FloatingField } from '@/components/auth/FloatingField'
import { PasswordField } from '@/components/auth/PasswordField'
import { SubmitButton } from '@/components/auth/SubmitButton'
import { DESIGN_STYLES, rise, type Design } from '@/components/auth/auth-styles'
import type { StaffPortal } from '@/components/StaffLoginForm'
import { sendJson } from '@/lib/client-fetch'

type Step =
  | { kind: 'password' }
  | { kind: 'enroll'; qrDataUrl: string; manualKey: string }
  | { kind: 'verify'; method: 'totp' | 'sms' | 'email' }

// The staff password + MFA state machine. `portal` (a department sign-in
// page) only adds an eyebrow above the heading -- the role a login grants
// always comes from the credentials, resolved server-side in POST /api/login.
const STEP_WRAP: Record<Design, string> = {
  // MFA / OTP steps use the neutral surface; on the dark immersive field they
  // sit on a card so their text keeps AA contrast.
  a: 'rounded-xl bg-card p-5 text-card-foreground sm:p-6',
  b: '',
  c: 'max-w-[440px]',
}

export function StaffSignInForm({ portal, below, design = 'a' }: { portal?: StaffPortal; below?: React.ReactNode; design?: Design }) {
  const s = DESIGN_STYLES[design]
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
      <div className={`auth-rise ${STEP_WRAP[design]}`} style={rise(0)}>
        <MfaEnrollStep qrDataUrl={step.qrDataUrl} manualKey={step.manualKey} onSubmit={submitMfaCode} />
      </div>
    )
  }
  if (step.kind === 'verify') {
    return (
      <div className={`auth-rise ${STEP_WRAP[design]}`} style={rise(0)}>
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
      <div className={`auth-rise ${s.head}`} style={rise(1)}>
        {portal ? <p className={s.eyebrow}>{portal.label}</p> : null}
        <h1 className={s.title}>Sign in</h1>
        <p className={s.subtitle}>Use your hospital email and password.</p>
      </div>
      <form onSubmit={handlePasswordSubmit} className={s.form}>
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
            design={design}
          />
        </div>
        <div className="auth-rise" style={rise(3)}>
          <PasswordField value={password} onChange={setPassword} required invalid={!!error} design={design} />
        </div>
        {error && (
          <div role="alert" className={`${s.alert} auth-pop-menu`}>
            {error}
          </div>
        )}
        <div className={`auth-rise ${s.submitWrap}`} style={rise(4)}>
          <SubmitButton className={s.button} disabled={submitting || done || !email || !password} submitting={submitting} done={done} />
        </div>
      </form>
      {below ? <div className={`auth-rise ${s.below}`} style={rise(5)}>{below}</div> : null}
    </>
  )
}
