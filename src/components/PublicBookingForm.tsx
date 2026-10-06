'use client'
import { useState } from 'react'

interface ProviderOption {
  id: number
  name: string
  specialty: string
}

interface FieldErrors {
  requesterName?: string
  requesterDob?: string
  requesterEmail?: string
  requesterPhone?: string
  preferredDateRangeStart?: string
  preferredDateRangeEnd?: string
  reason?: string
}

// Maps the zod .strict() `flatten().fieldErrors` shape from
// POST /api/public/booking-requests onto this form's field names -- the
// route's schema field names match this form's state names 1:1.
function mapFieldErrors(details: unknown): FieldErrors {
  const fieldErrors = (details as { fieldErrors?: Record<string, string[]> } | null)?.fieldErrors
  if (!fieldErrors) return {}
  const out: FieldErrors = {}
  for (const key of Object.keys(fieldErrors) as (keyof FieldErrors)[]) {
    const messages = fieldErrors[key]
    if (messages?.length) out[key] = messages[0]
  }
  return out
}

export function PublicBookingForm({ providers, providerAppointmentCounts }: {
  providers: ProviderOption[]
  // Pre-aggregated server-side -- never per-appointment rows. See the
  // comment in src/app/book/page.tsx for why: this is the one genuinely
  // unauthenticated page in the app, and a per-appointment row (even one
  // "narrowed" only by a TypeScript type) would leak PHI into the RSC
  // payload embedded in this page's HTML.
  providerAppointmentCounts: Record<number, number>
}) {
  const [requesterName, setRequesterName] = useState('')
  const [requesterDob, setRequesterDob] = useState('')
  const [requesterEmail, setRequesterEmail] = useState('')
  const [requesterPhone, setRequesterPhone] = useState('')
  const [preferredProviderId, setPreferredProviderId] = useState<number | ''>('')
  const [preferredDateRangeStart, setPreferredDateRangeStart] = useState('')
  const [preferredDateRangeEnd, setPreferredDateRangeEnd] = useState('')
  const [reason, setReason] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitted, setSubmitted] = useState(false)

  // Read-only hint only -- this widget never shows or claims an exact open
  // slot, per spec §1. It just gives the requester a rough sense of how
  // busy their selected provider already is, from a per-provider count
  // computed server-side over the page's whole display window (not scoped
  // to the requester's chosen date range -- see providerAppointmentCounts'
  // doc comment on the prop above for why no per-appointment data crosses
  // the server/client boundary at all).
  const existingCount = preferredProviderId !== '' ? (providerAppointmentCounts[preferredProviderId] ?? 0) : null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    setFieldErrors({})

    const res = await fetch('/api/public/booking-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requesterName,
        requesterDob,
        ...(requesterEmail ? { requesterEmail } : {}),
        ...(requesterPhone ? { requesterPhone } : {}),
        ...(preferredProviderId !== '' ? { preferredProviderId } : {}),
        preferredDateRangeStart,
        preferredDateRangeEnd,
        reason,
      }),
    })
    setSubmitting(false)

    if (res.status === 201) { setSubmitted(true); return }

    if (res.status === 429) {
      setError('Too many requests, please try again later.')
      return
    }

    if (res.status === 400) {
      const body = await res.json().catch(() => null)
      setFieldErrors(mapFieldErrors(body?.details))
      setError(body?.error ?? 'Please check the highlighted fields and try again.')
      return
    }

    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not submit your request. Please try again.')
  }

  if (submitted) {
    return (
      <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 text-center">
        <p className="text-sm font-medium text-foreground">Your request has been submitted.</p>
        <p className="mt-1 text-sm text-muted-foreground">Our team will contact you to confirm.</p>
      </div>
    )
  }

  const canSubmit =
    Boolean(requesterName) &&
    Boolean(requesterDob) &&
    Boolean(preferredDateRangeStart) &&
    Boolean(preferredDateRangeEnd) &&
    Boolean(reason) &&
    !submitting

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="requesterName" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Full name</label>
        <input
          id="requesterName"
          value={requesterName}
          onChange={(e) => setRequesterName(e.target.value)}
          className="w-full rounded-md border border-border px-3 py-2 text-sm"
        />
        {fieldErrors.requesterName && <p className="mt-1 text-xs text-destructive">{fieldErrors.requesterName}</p>}
      </div>

      <div>
        <label htmlFor="requesterDob" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date of birth</label>
        <input
          id="requesterDob"
          type="date"
          value={requesterDob}
          onChange={(e) => setRequesterDob(e.target.value)}
          className="w-full rounded-md border border-border px-3 py-2 text-sm"
        />
        {fieldErrors.requesterDob && <p className="mt-1 text-xs text-destructive">{fieldErrors.requesterDob}</p>}
      </div>

      <div className="flex gap-2">
        <div className="w-1/2">
          <label htmlFor="requesterEmail" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Email (optional)</label>
          <input
            id="requesterEmail"
            type="email"
            value={requesterEmail}
            onChange={(e) => setRequesterEmail(e.target.value)}
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {fieldErrors.requesterEmail && <p className="mt-1 text-xs text-destructive">{fieldErrors.requesterEmail}</p>}
        </div>
        <div className="w-1/2">
          <label htmlFor="requesterPhone" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Phone (optional)</label>
          <input
            id="requesterPhone"
            type="tel"
            value={requesterPhone}
            onChange={(e) => setRequesterPhone(e.target.value)}
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {fieldErrors.requesterPhone && <p className="mt-1 text-xs text-destructive">{fieldErrors.requesterPhone}</p>}
        </div>
      </div>

      <div>
        <label htmlFor="preferredProviderId" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preferred provider</label>
        <select
          id="preferredProviderId"
          value={preferredProviderId}
          onChange={(e) => setPreferredProviderId(e.target.value === '' ? '' : Number(e.target.value))}
          className="w-full rounded-md border border-border px-3 py-2 text-sm"
        >
          <option value="">No preference</option>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.specialty}</option>)}
        </select>
        {existingCount !== null && (
          <p className="mt-1 text-xs text-muted-foreground">
            {existingCount} appointment{existingCount === 1 ? '' : 's'} already on the schedule with this provider in the next 90 days. This is a read-only estimate, not an open-slot count.
          </p>
        )}
      </div>

      <div className="flex gap-2">
        <div className="w-1/2">
          <label htmlFor="preferredDateRangeStart" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Earliest preferred date</label>
          <input
            id="preferredDateRangeStart"
            type="date"
            value={preferredDateRangeStart}
            onChange={(e) => setPreferredDateRangeStart(e.target.value)}
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {fieldErrors.preferredDateRangeStart && <p className="mt-1 text-xs text-destructive">{fieldErrors.preferredDateRangeStart}</p>}
        </div>
        <div className="w-1/2">
          <label htmlFor="preferredDateRangeEnd" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest preferred date</label>
          <input
            id="preferredDateRangeEnd"
            type="date"
            value={preferredDateRangeEnd}
            onChange={(e) => setPreferredDateRangeEnd(e.target.value)}
            className="w-full rounded-md border border-border px-3 py-2 text-sm"
          />
          {fieldErrors.preferredDateRangeEnd && <p className="mt-1 text-xs text-destructive">{fieldErrors.preferredDateRangeEnd}</p>}
        </div>
      </div>

      <div>
        <label htmlFor="reason" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason for visit</label>
        <textarea
          id="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-border px-3 py-2 text-sm"
        />
        {fieldErrors.reason && <p className="mt-1 text-xs text-destructive">{fieldErrors.reason}</p>}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <button
        type="submit"
        disabled={!canSubmit}
        className="w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {submitting ? 'Submitting…' : 'Request appointment'}
      </button>
      <p className="text-center text-xs text-muted-foreground">
        This submits a request only — it does not guarantee a slot. Our team will follow up to confirm.
      </p>
    </form>
  )
}
