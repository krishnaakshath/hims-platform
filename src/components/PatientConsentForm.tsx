'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ShieldCheck } from 'lucide-react'

export function PatientConsentForm({ nppBody, tosBody }: { nppBody: string; tosBody: string }) {
  const router = useRouter()
  const [acceptedNpp, setAcceptedNpp] = useState(false)
  const [acceptedTos, setAcceptedTos] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    const res = await fetch('/api/patient-portal/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptedNpp, acceptedTos }),
    })
    setSubmitting(false)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not record your acceptance.')
      return
    }
    router.push('/patient-portal')
    router.refresh()
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-secondary/40 px-4 py-10">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-primary/10 to-transparent" aria-hidden="true" />
      <div className="relative w-full max-w-xl">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <h1 className="text-xl font-bold text-foreground">Before you continue</h1>
          <p className="text-sm text-muted-foreground">Please review and accept these two documents to access your portal.</p>
        </div>

        <form onSubmit={handleSubmit} className="rounded-2xl border border-primary/10 bg-card p-6 shadow-md">
          <ConsentSection label="Notice of Privacy Practices" body={nppBody} checked={acceptedNpp} onChange={setAcceptedNpp} checkboxId="npp" />
          <div className="my-5 border-t border-border" />
          <ConsentSection label="Terms of Service" body={tosBody} checked={acceptedTos} onChange={setAcceptedTos} checkboxId="tos" />

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={submitting || !acceptedNpp || !acceptedTos}
            className="mt-6 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Accept and continue'}
          </button>
        </form>
      </div>
    </div>
  )
}

function ConsentSection({ label, body, checked, onChange, checkboxId }: {
  label: string
  body: string
  checked: boolean
  onChange: (v: boolean) => void
  checkboxId: string
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">{label}</h2>
        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning">Draft — pending legal review</span>
      </div>
      <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-secondary/30 p-3 text-xs leading-relaxed text-muted-foreground">
        <pre className="whitespace-pre-wrap font-sans">{body}</pre>
      </div>
      <label htmlFor={checkboxId} className="mt-3 flex items-start gap-2 text-sm text-foreground">
        <input
          id={checkboxId}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary"
        />
        <span>I have read and accept the {label}.</span>
      </label>
    </div>
  )
}
