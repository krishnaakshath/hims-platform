'use client'
import { useState } from 'react'
import { sendJson } from '@/lib/client-fetch'

// Wave J (P1-20): portal sign-in with the UHID or registered mobile number and a one-time
// code sent by SMS to the number the hospital has on file.
import { AUTH_ALERT as ALERT, AUTH_INPUT as INPUT, AUTH_LABEL, AUTH_LINK_BUTTON, AUTH_PRIMARY_BUTTON as PRIMARY, AUTH_QUIET_BUTTON } from '@/components/auth/auth-styles'

export function PortalOtpSignIn({ onSignedIn, onMfaRequired, onUsePassword }: { onSignedIn: () => void; onMfaRequired: () => void; onUsePassword: () => void }) {
  const [identifier, setIdentifier] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<'identify' | 'code'>('identify')
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function sendCode(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await sendJson<{ message?: string }>('/api/patient-portal/login/otp', 'POST', { identifier })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setNotice(res.data?.message ?? null)
    setStep('code')
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await sendJson<{ mfaRequired?: boolean }>('/api/patient-portal/login/otp/verify', 'POST', { identifier, code }, { passThrough: [401] })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    if (res.data?.mfaRequired) { onMfaRequired(); return }
    onSignedIn()
  }

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold leading-8 tracking-[-0.015em] text-foreground">Sign in with a mobile code</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">We will text a 6-digit code to the mobile number the hospital has on file.</p>
      </div>
      {step === 'identify' ? (
        <form onSubmit={sendCode} className="space-y-6">
          <div>
            <label htmlFor="otp-identifier" className={`${AUTH_LABEL} mb-2`}>UHID or mobile number</label>
            <input id="otp-identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoCapitalize="characters" spellCheck={false} placeholder="UHID or 10-digit mobile" className={INPUT} />
          </div>
          {error && <div role="alert" className={ALERT}>{error}</div>}
          <button type="submit" disabled={busy || !identifier.trim()} className={PRIMARY}>{busy ? 'Sending…' : 'Send code'}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-6">
          {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
          <div>
            <label htmlFor="otp-code" className={`${AUTH_LABEL} mb-2`}>6-digit code</label>
            <input id="otp-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className={INPUT} />
          </div>
          {error && <div role="alert" className={ALERT}>{error}</div>}
          <button type="submit" disabled={busy || code.length !== 6} className={PRIMARY}>{busy ? 'Checking…' : 'Sign in'}</button>
          <button type="button" onClick={() => { setStep('identify'); setCode(''); setError(null) }} className={AUTH_QUIET_BUTTON}>Send a new code</button>
        </form>
      )}
      <button type="button" onClick={onUsePassword} className={`${AUTH_LINK_BUTTON} mt-3`}>Use my password instead</button>
    </div>
  )
}
