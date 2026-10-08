'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BrandLogo } from '@/components/BrandLogo'
import { MfaCodeStep } from '@/components/mfa/MfaCodeStep'
import { PortalOtpSignIn } from '@/components/portal/PortalOtpSignIn' // Wave J

export default function PatientPortalLoginPage() {
  const router = useRouter()
  const [patientId, setPatientId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [needsMfa, setNeedsMfa] = useState(false)
  const [otpMode, setOtpMode] = useState(false) // Wave J (P1-20)

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
    router.push('/patient-portal')
  }

  async function submitMfaCode(code: string): Promise<string | null> {
    const res = await sendJson('/api/patient-portal/login/mfa', 'POST', { code }, { passThrough: [401] })
    if (!res.ok) return res.error
    router.push('/patient-portal')
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
          {needsMfa ? (
            <MfaCodeStep
              title="Enter your code"
              description="Open your authenticator app and enter the current 6-digit code."
              onSubmit={submitMfaCode}
              onBack={() => setNeedsMfa(false)}
            />
          ) : otpMode ? (
            <PortalOtpSignIn onMfaRequired={() => setNeedsMfa(true)} onSignedIn={() => router.push('/patient-portal')} onUsePassword={() => setOtpMode(false)} />
          ) : (
            <>
              <div className="mb-8 text-center">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Welcome back</h1>
                <p className="mt-2 text-sm text-muted-foreground">Sign in to your account.</p>
              </div>

              <form onSubmit={submit} className="space-y-5">
                <div className="space-y-1.5">
                  <label htmlFor="patientId" className="text-sm font-medium leading-none">
                    Email address or patient ID
                  </label>
                  <input
                    id="patientId"
                    value={patientId}
                    onChange={(e) => setPatientId(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby="patientId-hint"
                    placeholder="name@example.com or RD-0001"
                    className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <p id="patientId-hint" className="text-xs text-muted-foreground">
                    Use the email address the clinic has on file, or the UHID or patient ID from your paperwork.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="password" className="text-sm font-medium leading-none">
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="flex h-11 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
                
                {error && (
                  <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm font-medium text-destructive">
                    {error}
                  </div>
                )}
                
                <button
                  type="submit"
                  disabled={submitting || !patientId || !password}
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
              <button type="button" onClick={() => { setError(null); setOtpMode(true) }} className="mt-4 inline-flex min-h-11 w-full items-center justify-center text-sm font-medium text-primary hover:underline">
                Sign in with a code sent to your mobile
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
