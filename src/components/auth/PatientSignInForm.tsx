'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MfaCodeStep } from '@/components/mfa/MfaCodeStep'
import { PortalOtpSignIn } from '@/components/portal/PortalOtpSignIn' // Wave J
import { FloatingField } from '@/components/auth/FloatingField'
import { PasswordField } from '@/components/auth/PasswordField'
import { SubmitButton } from '@/components/auth/SubmitButton'
import { BADGE as s, rise } from '@/components/auth/auth-styles'
import { sendJson } from '@/lib/client-fetch'
import { useBrand } from '@/components/BrandProvider'

// Patient portal sign-in: email or patient ID + password, or a code sent to
// the mobile on file (Wave J, P1-20), then TOTP when the account has it.

export function PatientSignInForm({ below }: { below?: React.ReactNode }) {
  const router = useRouter()
  const { portalName } = useBrand()
  const [patientId, setPatientId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [needsMfa, setNeedsMfa] = useState(false)
  const [otpMode, setOtpMode] = useState(false)

  function finish() {
    setDone(true)
    router.push('/patient-portal')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    // 401 carries the route's own sign-in message ("Invalid patient ID or password").
    const res = await sendJson<{ mfaRequired?: boolean }>('/api/patient-portal/login', 'POST', { patientId, password }, { passThrough: [401] })
    setSubmitting(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (res.data?.mfaRequired) {
      setNeedsMfa(true)
      return
    }
    finish()
  }

  async function submitMfaCode(code: string): Promise<string | null> {
    const res = await sendJson('/api/patient-portal/login/mfa', 'POST', { code }, { passThrough: [401] })
    if (!res.ok) return res.error
    router.push('/patient-portal')
    return null
  }

  if (needsMfa) {
    return (
      <div className="auth-rise" style={rise(0)}>
        <MfaCodeStep
          title="Enter your code"
          description="Open your authenticator app and enter the current 6-digit code."
          onSubmit={submitMfaCode}
          onBack={() => setNeedsMfa(false)}
        />
      </div>
    )
  }
  if (otpMode) {
    return (
      <div className="auth-rise" style={rise(0)}>
        <PortalOtpSignIn onMfaRequired={() => setNeedsMfa(true)} onSignedIn={() => router.push('/patient-portal')} onUsePassword={() => setOtpMode(false)} />
      </div>
    )
  }

  return (
    <>
      <div className={`auth-rise ${s.head}`} style={rise(1)}>
        <p className={s.eyebrow}>{portalName}</p>
        <h1 className={s.title}>Sign in</h1>
        <p className={s.subtitle}>Your records, forms and messages.</p>
      </div>
      <form onSubmit={submit} className={s.form}>
        <div className="auth-rise" style={rise(2)}>
          <FloatingField
            id="patientId"
            label="Email address or patient ID"
            value={patientId}
            onChange={setPatientId}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby="patientId-hint"
            placeholder="name@example.com or RD-0001"
            invalid={!!error}
            hint="Use the email address the clinic has on file, or the UHID or patient ID from your paperwork."
            hintId="patientId-hint"
          />
        </div>
        <div className="auth-rise" style={rise(3)}>
          <PasswordField value={password} onChange={setPassword} invalid={!!error} />
        </div>
        {error && (
          <div role="alert" className={`${s.alert} auth-pop-menu`}>
            {error}
          </div>
        )}
        <div className={`auth-rise ${s.submitWrap}`} style={rise(4)}>
          <SubmitButton className={s.button} disabled={submitting || done || !patientId || !password} submitting={submitting} done={done} />
        </div>
      </form>
      <div className="auth-rise mt-3" style={rise(5)}>
        <button type="button" onClick={() => { setError(null); setOtpMode(true) }} className={s.link}>
          Sign in with a code sent to your mobile
        </button>
      </div>
      {below ? <div className={`auth-rise ${s.below}`} style={rise(6)}>{below}</div> : null}
    </>
  )
}
