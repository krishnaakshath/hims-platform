'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, MessageSquareText, Users, Send } from 'lucide-react'

interface Trial { id: string; condition: string }
interface RecipientCandidate { id: string; name: string; phone: string | null; email: string | null }

const SECTION = 'rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm backdrop-blur-sm'
const FIELD = 'w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring'

const STEPS = [
  { label: 'Write a Message', icon: MessageSquareText },
  { label: 'Specify Recipients', icon: Users },
  { label: 'Review and Send', icon: Send },
] as const

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="mb-6 flex items-center">
      {STEPS.map(({ label, icon: Icon }, i) => {
        const n = i + 1
        const isComplete = step > n
        const isCurrent = step === n
        return (
          <div key={label} className={`flex items-center ${i < STEPS.length - 1 ? 'flex-1' : ''}`}>
            <div className="flex items-center gap-2">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                  isCurrent ? 'bg-primary text-primary-foreground' : isComplete ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'
                }`}
                aria-hidden="true"
              >
                {isComplete ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
              </span>
              <span className={`hidden text-sm font-medium sm:inline ${isCurrent ? 'text-foreground' : 'text-muted-foreground'}`}>
                {n}. {label}
              </span>
            </div>
            {i < STEPS.length - 1 && <div className={`mx-3 h-px flex-1 transition-colors ${isComplete ? 'bg-primary/40' : 'bg-border'}`} aria-hidden="true" />}
          </div>
        )
      })}
    </div>
  )
}

const OVERALL_STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'green', label: 'Meets' },
  { value: 'yellow', label: 'Needs Verification' },
  { value: 'red', label: 'Potential Exclusion' },
]

const FORM_STATUS_OPTIONS = [
  { value: '', label: 'Any form status' },
  { value: 'sent', label: 'Form sent, not started' },
  { value: 'partial', label: 'Form partially completed' },
  { value: 'completed', label: 'Form completed' },
  { value: 'none', label: 'No form sent yet' },
]

export function BroadcastWizard({ trials }: { trials: Trial[] }) {
  const router = useRouter()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [channel, setChannel] = useState<'sms' | 'email' | 'both'>('sms')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [trialId, setTrialId] = useState('')
  const [overallStatus, setOverallStatus] = useState('')
  const [formStatus, setFormStatus] = useState('')
  const [candidates, setCandidates] = useState<RecipientCandidate[] | null>(null)
  const [loadingCandidates, setLoadingCandidates] = useState(false)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<{ recipientCount: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const messageTooLong = channel === 'sms' && message.length > 140
  const missingSubject = (channel === 'email' || channel === 'both') && subject.trim().length === 0

  async function loadCandidates() {
    setLoadingCandidates(true)
    setError(null)
    const params = new URLSearchParams()
    if (trialId) params.set('trialId', trialId)
    if (overallStatus) params.set('overallStatus', overallStatus)
    if (formStatus) params.set('formStatus', formStatus)
    const res = await fetch(`/api/broadcasts/recipients?${params.toString()}`)
    setLoadingCandidates(false)
    if (res.ok) {
      setCandidates(await res.json())
    } else {
      setError('Could not load recipients for this filter.')
    }
  }

  async function send() {
    setSending(true)
    setError(null)
    const res = await fetch('/api/broadcasts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: subject || undefined,
        message,
        channel,
        filterTrialId: trialId || undefined,
        filterOverallStatus: overallStatus || undefined,
        filterFormStatus: formStatus || undefined,
      }),
    })
    setSending(false)
    if (res.ok) {
      const created = await res.json()
      setSent({ recipientCount: created.recipientCount })
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not send broadcast.')
    }
  }

  if (sent) {
    return (
      <div className={`max-w-xl ${SECTION}`}>
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success" aria-hidden="true">
          <Check className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-foreground">Broadcast sent to {sent.recipientCount} recipient{sent.recipientCount === 1 ? '' : 's'}.</p>
        <p className="mt-1 text-xs text-muted-foreground">Simulated delivery only — no real SMS or email was sent.</p>
        <button
          onClick={() => { setSent(null); setStep(1); setMessage(''); setSubject(''); setCandidates(null) }}
          className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Send Another Broadcast
        </button>
      </div>
    )
  }

  return (
    <div className={`max-w-xl ${SECTION}`}>
      <Stepper step={step} />

      {error && <p className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label htmlFor="broadcast-channel" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</label>
            <select id="broadcast-channel" value={channel} onChange={(e) => setChannel(e.target.value as 'sms' | 'email' | 'both')} className={FIELD}>
              <option value="sms">SMS</option>
              <option value="email">Email</option>
              <option value="both">SMS and Email</option>
            </select>
          </div>
          {(channel === 'email' || channel === 'both') && (
            <div>
              <label htmlFor="broadcast-subject" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Subject</label>
              <input id="broadcast-subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject line for this email…" className={FIELD} />
            </div>
          )}
          <div>
            <label htmlFor="broadcast-message" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</label>
            <textarea
              id="broadcast-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Type your message to patients here…"
              className={FIELD}
            />
            {channel === 'sms' && <p className={`mt-1 text-xs ${messageTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>{message.length}/140 characters</p>}
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setStep(2)}
              disabled={message.trim().length === 0 || messageTooLong || missingSubject}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Next: Specify Recipients
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <label htmlFor="broadcast-trial" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trial</label>
            <select id="broadcast-trial" value={trialId} onChange={(e) => { setTrialId(e.target.value); setCandidates(null) }} className={FIELD}>
              <option value="">All trials</option>
              {trials.map((t) => <option key={t.id} value={t.id}>{t.condition}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="broadcast-overall-status" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Screening Status</label>
            <select id="broadcast-overall-status" value={overallStatus} onChange={(e) => { setOverallStatus(e.target.value); setCandidates(null) }} className={FIELD}>
              {OVERALL_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="broadcast-form-status" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Form Status</label>
            <select id="broadcast-form-status" value={formStatus} onChange={(e) => { setFormStatus(e.target.value); setCandidates(null) }} className={FIELD}>
              {FORM_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <button onClick={loadCandidates} disabled={loadingCandidates} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
            {loadingCandidates ? 'Loading…' : 'Preview Recipients'}
          </button>
          {candidates && (
            <p className="rounded-md border border-primary/10 bg-primary/5 px-3 py-2 text-sm font-medium text-foreground">
              {candidates.length} patient{candidates.length === 1 ? '' : 's'} match this filter.
            </p>
          )}
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary">Back</button>
            <button
              onClick={() => setStep(3)}
              disabled={!candidates || candidates.length === 0}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Next: Review and Send
            </button>
          </div>
        </div>
      )}

      {step === 3 && candidates && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-secondary/30 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</p>
            <p className="mt-1 text-sm text-foreground">{message}</p>
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</p>
            <p className="mt-1 text-sm text-foreground">{channel === 'both' ? 'SMS and Email' : channel === 'sms' ? 'SMS' : 'Email'}</p>
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients</p>
            <p className="mt-1 text-sm text-foreground">{candidates.length} patient{candidates.length === 1 ? '' : 's'}</p>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm text-muted-foreground">
              {candidates.map((c) => <li key={c.id}>{c.name}</li>)}
            </ul>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary">Back</button>
            <button onClick={send} disabled={sending} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {sending ? 'Sending…' : 'Send Broadcast'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
