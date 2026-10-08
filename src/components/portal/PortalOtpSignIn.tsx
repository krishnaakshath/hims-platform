'use client'
import { useState } from 'react'
import { sendJson } from '@/lib/client-fetch'

// Wave J (P1-20): portal sign-in with the UHID or registered mobile number and a one-time
// code sent by SMS to the number the hospital has on file.
const INPUT = 'flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary'
const PRIMARY = 'inline-flex h-11 w-full items-center justify-center rounded-md bg-primary px-8 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50'

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
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Sign in with a mobile code</h1>
        <p className="mt-2 text-sm text-muted-foreground">We will text a 6-digit code to the mobile number the hospital has on file.</p>
      </div>
      {step === 'identify' ? (
        <form onSubmit={sendCode} className="space-y-5">
          <div className="space-y-1.5">
            <label htmlFor="otp-identifier" className="text-sm font-medium leading-none">UHID or mobile number</label>
            <input id="otp-identifier" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoComplete="username" autoCapitalize="characters" spellCheck={false} placeholder="UHID or 10-digit mobile" className={INPUT} />
          </div>
          {error && <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive">{error}</div>}
          <button type="submit" disabled={busy || !identifier.trim()} className={PRIMARY}>{busy ? 'Sending…' : 'Send code'}</button>
        </form>
      ) : (
        <form onSubmit={verify} className="space-y-5">
          {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
          <div className="space-y-1.5">
            <label htmlFor="otp-code" className="text-sm font-medium leading-none">6-digit code</label>
            <input id="otp-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" className={INPUT} />
          </div>
          {error && <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive">{error}</div>}
          <button type="submit" disabled={busy || code.length !== 6} className={PRIMARY}>{busy ? 'Checking…' : 'Sign in'}</button>
          <button type="button" onClick={() => { setStep('identify'); setCode(''); setError(null) }} className="inline-flex min-h-11 w-full items-center justify-center text-sm text-muted-foreground hover:underline">Send a new code</button>
        </form>
      )}
      <button type="button" onClick={onUsePassword} className="mt-2 inline-flex min-h-11 w-full items-center justify-center text-sm font-medium text-primary hover:underline">Use my password instead</button>
    </div>
  )
}
