'use client'
import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Field, INPUT_CLASS } from '@/components/registration/Field'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { AbhaConsentStep, type ConsentText } from './AbhaConsentStep'

// Create or verify a patient's ABHA through ABDM (SP8 Task 5). Steps: choose
// method -> consent (verbatim text) -> identifier -> OTP -> (account choice)
// -> (address choice) -> confirm. The Aadhaar number and OTPs live only in
// component state until their request resolves, then are cleared; the server
// never returns tokens or transaction ids.

export type AbdmStatus = { state: 'configured' | 'mock'; label: string; enrolment: ConsentText | null; verification: ConsentText }
export type VerifiedAbha = { abhaNumber: string; abhaAddress: string | null; flowId: string }

type Method = 'enrolment' | 'abha_number_aadhaar_otp' | 'abha_number_mobile_otp' | 'mobile_otp' | 'aadhaar_otp_login' | 'abha_address_otp'
type Step = 'method' | 'consent' | 'identifier' | 'otp' | 'account' | 'address' | 'confirm'
type Profile = { name: string; gender: string | null; yearOfBirth: number | null; abhaNumber: string; abhaAddress: string | null }

const METHODS: { value: Method; label: string }[] = [
  { value: 'enrolment', label: 'Create a new ABHA with Aadhaar OTP' },
  { value: 'abha_number_mobile_otp', label: 'Verify by ABHA number (OTP to the ABHA mobile)' },
  { value: 'abha_number_aadhaar_otp', label: 'Verify by ABHA number (OTP to the Aadhaar mobile)' },
  { value: 'mobile_otp', label: 'Verify by mobile number' },
  { value: 'aadhaar_otp_login', label: 'Verify by Aadhaar OTP' },
  { value: 'abha_address_otp', label: 'Verify by ABHA address' },
]
const IDENTIFIER_LABEL: Record<Exclude<Method, 'enrolment'>, string> = {
  abha_number_aadhaar_otp: 'ABHA number',
  abha_number_mobile_otp: 'ABHA number',
  mobile_otp: 'Mobile number',
  aadhaar_otp_login: 'Aadhaar number',
  abha_address_otp: 'ABHA address',
}
// The routes' fixed messages are shown for these statuses as well.
const PASS = { passThrough: [410, 429, 502, 503] as const }

export const SANDBOX_MOCK_LABEL = 'Sandbox mock - not real'

export function AbhaVerifyDialog({ patientId, mode, status, onVerified, onClose }: {
  patientId: string | null
  mode: 'register' | 'profile'
  status: AbdmStatus
  onVerified: (v: VerifiedAbha) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>('method')
  const [method, setMethod] = useState<Method>('abha_number_mobile_otp')
  const [flowId, setFlowId] = useState<string | null>(null)
  const [aadhaar, setAadhaar] = useState('')
  const [loginId, setLoginId] = useState('')
  const [otp, setOtp] = useState('')
  const [mobile, setMobile] = useState('')
  const [accounts, setAccounts] = useState<{ abhaNumber: string; name: string | null }[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isEnrolment = method === 'enrolment'
  const consent = isEnrolment ? status.enrolment : status.verification
  const secretIdentifier = method === 'aadhaar_otp_login'

  // Never keep a typed national ID number or OTP beyond the dialog.
  useEffect(() => () => { setAadhaar(''); setOtp(''); setLoginId('') }, [])

  async function run<T>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, then: (data: T) => void) {
    setBusy(true); setError(null)
    try {
      const r = await fn()
      if (r.ok) then(r.data)
      else setError(r.error)
    } finally {
      setBusy(false)
    }
  }

  const recordConsent = (givenBy: 'patient' | 'guardian') => run(
    () => sendJson<{ flowId: string }>('/api/abdm/abha/consent', 'POST', {
      ...(patientId ? { patientId } : {}), purpose: isEnrolment ? 'abha_enrolment' : 'abha_verification', givenBy, textSha256: consent!.sha256,
    }, PASS),
    (d) => { setFlowId(d.flowId); setStep('identifier') },
  )

  const requestOtp = () => {
    if (isEnrolment) {
      return run(
        () => sendJson('/api/abdm/abha/enrol/otp', 'POST', { flowId, aadhaar }, PASS).finally(() => setAadhaar('')),
        () => setStep('otp'),
      )
    }
    return run(
      () => sendJson('/api/abdm/abha/login/otp', 'POST', { flowId, route: method, loginId }, PASS).finally(() => { if (secretIdentifier) setLoginId('') }),
      () => setStep('otp'),
    )
  }

  type VerifyResponse = { step: 'verified' | 'choose_account'; profile?: Profile; suggestions?: string[]; accounts?: { abhaNumber: string; name: string | null }[] }
  const verifyOtp = () => run(
    () => (isEnrolment
      ? sendJson<VerifyResponse>('/api/abdm/abha/enrol/verify', 'POST', { flowId, otp, mobile }, PASS)
      : sendJson<VerifyResponse>('/api/abdm/abha/login/verify', 'POST', { flowId, otp }, PASS)).finally(() => setOtp('')),
    (d) => {
      if (d.step === 'choose_account') { setAccounts(d.accounts ?? []); setStep('account'); return }
      setProfile(d.profile ?? null)
      if (isEnrolment && (d.suggestions?.length ?? 0) > 0) { setSuggestions(d.suggestions!); setStep('address') } else setStep('confirm')
    },
  )

  const chooseAccount = (accountIndex: number) => run(
    () => sendJson<{ profile: Profile }>('/api/abdm/abha/login/account', 'POST', { flowId, accountIndex }, PASS),
    (d) => { setProfile(d.profile); setStep('confirm') },
  )

  const chooseAddress = (abhaAddress: string) => run(
    () => sendJson<{ abhaAddress: string }>('/api/abdm/abha/enrol/address', 'POST', { flowId, abhaAddress }, PASS),
    (d) => { setProfile((p) => (p ? { ...p, abhaAddress: d.abhaAddress } : p)); setStep('confirm') },
  )

  const confirm = () => {
    if (!profile || !flowId) return
    const v = { abhaNumber: profile.abhaNumber, abhaAddress: profile.abhaAddress, flowId }
    if (mode === 'register' || !patientId) { onVerified(v); return }
    return run(
      () => fetchJson(`/api/patients/${encodeURIComponent(patientId)}/abha/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId }) }, PASS),
      () => onVerified(v),
    )
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4" aria-hidden="true" />ABHA with ABDM</DialogTitle>
        </DialogHeader>
        {status.state === 'mock' && (
          <p className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900" role="note">{SANDBOX_MOCK_LABEL}</p>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        {step === 'method' && (
          <div className="space-y-3">
            <fieldset className="space-y-1 text-sm">
              <legend className="mb-1 text-xs font-medium">How</legend>
              {METHODS.map((m) => (
                <label key={m.value} className="flex items-center gap-2">
                  <input type="radio" name="abha-method" checked={method === m.value} onChange={() => setMethod(m.value)} />
                  {m.label}
                </label>
              ))}
            </fieldset>
            <Button type="button" onClick={() => setStep('consent')}>Continue</Button>
          </div>
        )}

        {step === 'consent' && (consent
          ? <AbhaConsentStep consent={consent} busy={busy} onAgree={recordConsent} />
          : <p role="alert" className="text-sm text-destructive">ABHA creation is not available until the NHA consent text is installed (see docs/ABDM-NHCX.md)</p>)}

        {step === 'identifier' && (
          <div className="space-y-3">
            {isEnrolment ? (
              <Field label="Aadhaar number">
                {(p) => (
                  <input {...p} type="password" autoComplete="off" inputMode="numeric" value={aadhaar}
                    onChange={(e) => setAadhaar(e.target.value.replace(/\D/g, '').slice(0, 12))} className={INPUT_CLASS} />
                )}
              </Field>
            ) : (
              <Field label={IDENTIFIER_LABEL[method as Exclude<Method, 'enrolment'>]}>
                {(p) => (
                  <input {...p} type={secretIdentifier ? 'password' : 'text'} autoComplete="off" inputMode={method === 'abha_address_otp' ? 'text' : 'numeric'}
                    value={loginId} onChange={(e) => setLoginId(e.target.value.slice(0, 60))} className={INPUT_CLASS} />
                )}
              </Field>
            )}
            <Button type="button" disabled={busy || (isEnrolment ? aadhaar.length !== 12 : loginId.trim() === '')} onClick={requestOtp}>Send OTP</Button>
          </div>
        )}

        {step === 'otp' && (
          <div className="space-y-3">
            <Field label="OTP">
              {(p) => <input {...p} type="password" autoComplete="one-time-code" inputMode="numeric" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} className={INPUT_CLASS} />}
            </Field>
            {isEnrolment && (
              <Field label="Mobile number for the ABHA" hint="10 digits">
                {(p) => <input {...p} type="tel" autoComplete="off" inputMode="numeric" value={mobile} onChange={(e) => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))} className={INPUT_CLASS} />}
              </Field>
            )}
            <Button type="button" disabled={busy || otp.length !== 6 || (isEnrolment && mobile.length !== 10)} onClick={verifyOtp}>Verify</Button>
          </div>
        )}

        {step === 'account' && (
          <div className="space-y-2">
            <p className="text-sm">Choose the patient&apos;s ABHA</p>
            {accounts.map((a, i) => (
              <Button key={`${a.abhaNumber}-${i}`} type="button" variant="outline" className="w-full justify-start font-mono" disabled={busy} onClick={() => chooseAccount(i)}>
                {a.abhaNumber}{a.name ? ` (${a.name})` : ''}
              </Button>
            ))}
          </div>
        )}

        {step === 'address' && (
          <div className="space-y-2">
            <p className="text-sm">Choose an ABHA address</p>
            {suggestions.map((s) => (
              <Button key={s} type="button" variant="outline" className="w-full justify-start" disabled={busy} onClick={() => chooseAddress(s)}>{s}</Button>
            ))}
            <Button type="button" variant="ghost" onClick={() => setStep('confirm')}>Skip</Button>
          </div>
        )}

        {step === 'confirm' && profile && (
          <div className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">Name</dt><dd>{profile.name}</dd>
              <dt className="text-muted-foreground">ABHA number</dt><dd className="font-mono">{profile.abhaNumber}</dd>
              <dt className="text-muted-foreground">ABHA address</dt><dd>{profile.abhaAddress ?? 'None'}</dd>
              <dt className="text-muted-foreground">Year of birth</dt><dd>{profile.yearOfBirth ?? 'Not given'}</dd>
            </dl>
            <Button type="button" disabled={busy} onClick={confirm}>{mode === 'register' ? 'Use this ABHA' : 'Link to this patient'}</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The entry button. Asks the server once whether ABDM is connected; when it is
 * not, the button is disabled with the title "ABDM not connected".
 */
export function AbhaVerifyButton({ patientId, mode, label, onVerified }: {
  patientId: string | null
  mode: 'register' | 'profile'
  label: string
  onVerified: (v: VerifiedAbha) => void
}) {
  const [status, setStatus] = useState<AbdmStatus | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    fetchJson<AbdmStatus>('/api/abdm/abha/consent').then((r) => {
      if (!live) return
      setStatus(r.ok ? r.data : null)
    })
    return () => { live = false }
  }, [])
  const connected = status !== null
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={!connected} title={connected ? undefined : 'ABDM not connected'} onClick={() => setOpen(true)}>
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />{label}
      </Button>
      {status?.state === 'mock' && <span className="ml-2 text-xs font-semibold text-amber-800">{SANDBOX_MOCK_LABEL}</span>}
      {open && status && (
        <AbhaVerifyDialog patientId={patientId} mode={mode} status={status} onClose={() => setOpen(false)}
          onVerified={(v) => { setOpen(false); onVerified(v) }} />
      )}
    </>
  )
}
