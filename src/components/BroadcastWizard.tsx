'use client'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { audienceSummaryLine, BROADCAST_MESSAGE_MAX } from '@/lib/broadcasts/audience'
import { LANGUAGES } from '@/lib/india/reference'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/components/ui/toast'
import { Check, MessageSquareText, Users, Send } from 'lucide-react'

interface Trial { id: string; condition: string }
interface Option { id: number; name: string }
interface PreviewRecipient { id: string; uhid: string | null; name: string }
interface AudienceCounts { match: number; optedOut: number; noPhone: number; sendable: number }
interface Preview { counts: AudienceCounts; recipients: PreviewRecipient[] }
interface SendResult { id: number; recipientCount: number; sentCount: number; skippedCount: number; failedCount: number }

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

const FOLLOW_UP_OPTIONS = [
  { value: '', label: 'Any' },
  { value: 'overdue', label: 'Follow-up overdue' },
  { value: 'due_7_days', label: 'Follow-up due in the next 7 days' },
]

const LABEL = 'mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

type FilterKey = 'departmentId' | 'providerId' | 'ageMin' | 'ageMax' | 'ward' | 'followUpDue' | 'language' | 'pinCodePrefix' | 'trialId' | 'overallStatus' | 'formStatus'
type FilterState = Record<FilterKey, string>
const EMPTY_FILTERS: FilterState = { departmentId: '', providerId: '', ageMin: '', ageMax: '', ward: '', followUpDue: '', language: '', pinCodePrefix: '', trialId: '', overallStatus: '', formStatus: '' }
const NUMERIC: FilterKey[] = ['departmentId', 'providerId', 'ageMin', 'ageMax']
const TRIAL_KEYS: FilterKey[] = ['trialId', 'overallStatus']

function activeFilters(f: FilterState, trialsOn: boolean): [FilterKey, string][] {
  return (Object.entries(f) as [FilterKey, string][]).filter(([k, v]) => v.trim() !== '' && (trialsOn || !TRIAL_KEYS.includes(k)))
}

export function BroadcastWizard({
  trials,
  showTrialFilters = true,
  departments = [],
  providers = [],
  wards = [],
}: { trials: Trial[]; showTrialFilters?: boolean; departments?: Option[]; providers?: Option[]; wards?: string[] }) {
  const router = useRouter()
  const toast = useToast()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [message, setMessage] = useState('')
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [typedCount, setTypedCount] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<SendResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const messageTooLong = message.length > BROADCAST_MESSAGE_MAX
  const pinInvalid = filters.pinCodePrefix !== '' && !/^\d{3,6}$/.test(filters.pinCodePrefix)
  const sendable = preview?.counts.sendable ?? 0
  const countConfirmed = typedCount.trim() === String(sendable)

  function setFilter(key: FilterKey, value: string) {
    setFilters((f) => ({ ...f, [key]: value }))
    setPreview(null)
    setTypedCount('')
  }

  async function loadPreview() {
    setLoadingPreview(true)
    setError(null)
    const params = new URLSearchParams(activeFilters(filters, showTrialFilters))
    const res = await fetchJson<Preview>(`/api/broadcasts/recipients?${params.toString()}`)
    setLoadingPreview(false)
    if (res.ok) {
      setPreview(res.data)
    } else {
      setError(`Could not load recipients for this filter. ${res.error}`)
    }
  }

  async function send() {
    setSending(true)
    setError(null)
    const body = Object.fromEntries(activeFilters(filters, showTrialFilters).map(([k, v]) => [k, NUMERIC.includes(k) ? Number(v) : v.trim()]))
    const res = await sendJson<SendResult>('/api/broadcasts', 'POST', { message: message.trim(), filters: body, confirmCount: Number(typedCount.trim()) })
    setSending(false)
    if (res.ok) {
      setSent(res.data)
      router.refresh()
      // WS7 T16: next step is the broadcast's per-patient delivery log.
      const n = res.data.sentCount
      toast.show({ title: `Sent to ${n} patient${n === 1 ? '' : 's'}`, action: { label: 'View log', href: `/broadcasts/${res.data.id}` } })
    } else if (res.status === 409) {
      // The audience changed since the preview: show the fresh count and ask for it again.
      await loadPreview()
      setTypedCount('')
      setError('The number of recipients has changed. Check the new count and type it again to confirm.')
    } else {
      setError(res.error)
    }
  }

  if (sent) {
    return (
      <div className={`max-w-xl ${SECTION}`}>
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success" aria-hidden="true">
          <Check className="h-5 w-5" />
        </span>
        <p className="text-sm font-medium text-foreground">Broadcast sent to {sent.sentCount} patient{sent.sentCount === 1 ? '' : 's'}.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {sent.sentCount} sent · {sent.skippedCount} skipped · {sent.failedCount} not delivered. Each patient&apos;s delivery is in the notification log.
        </p>
        <button
          onClick={() => { setSent(null); setStep(1); setMessage(''); setPreview(null); setTypedCount('') }}
          className="mt-4 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Send Another Broadcast
        </button>
      </div>
    )
  }

  const select = (key: FilterKey, label: string, options: { value: string; label: string }[]) => (
    <div>
      <label htmlFor={`broadcast-${key}`} className={LABEL}>{label}</label>
      <select id={`broadcast-${key}`} value={filters[key]} onChange={(e) => setFilter(key, e.target.value)} className={FIELD}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )

  return (
    <div className={`max-w-xl ${SECTION}`}>
      <Stepper step={step} />

      {error && <p role="alert" className="mb-4 rounded-md border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label htmlFor="broadcast-message" className={LABEL}>Message</label>
            <textarea
              id="broadcast-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              placeholder="Type your message to patients here…"
              className={FIELD}
            />
            <p className={`mt-1 text-xs ${messageTooLong ? 'text-destructive' : 'text-muted-foreground'}`}>{message.length}/{BROADCAST_MESSAGE_MAX} characters</p>
            <p className="mt-1 text-xs text-muted-foreground">Sent by SMS or WhatsApp with the hospital name in front. Do not include clinical details.</p>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setStep(2)}
              disabled={message.trim().length === 0 || messageTooLong}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Next: Specify Recipients
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {select('departmentId', 'Department (last 12 months)', [{ value: '', label: 'Any department' }, ...departments.map((d) => ({ value: String(d.id), label: d.name }))])}
            {select('providerId', 'Doctor (last 12 months)', [{ value: '', label: 'Any doctor' }, ...providers.map((p) => ({ value: String(p.id), label: p.name }))])}
            <div>
              <label htmlFor="broadcast-ageMin" className={LABEL}>Minimum age</label>
              <input id="broadcast-ageMin" type="number" min={0} max={120} inputMode="numeric" value={filters.ageMin} onChange={(e) => setFilter('ageMin', e.target.value)} className={FIELD} />
            </div>
            <div>
              <label htmlFor="broadcast-ageMax" className={LABEL}>Maximum age</label>
              <input id="broadcast-ageMax" type="number" min={0} max={120} inputMode="numeric" value={filters.ageMax} onChange={(e) => setFilter('ageMax', e.target.value)} className={FIELD} />
            </div>
            {select('ward', 'Currently admitted in ward', [{ value: '', label: 'Any (admitted or not)' }, ...wards.map((w) => ({ value: w, label: w }))])}
            {select('followUpDue', 'Follow-up', FOLLOW_UP_OPTIONS)}
            {select('language', 'Preferred language', [{ value: '', label: 'Any language' }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.label }))])}
            <div>
              <label htmlFor="broadcast-pinCodePrefix" className={LABEL}>PIN code starts with</label>
              <input id="broadcast-pinCodePrefix" inputMode="numeric" maxLength={6} placeholder="e.g. 560" value={filters.pinCodePrefix} onChange={(e) => setFilter('pinCodePrefix', e.target.value)} className={FIELD} />
              {pinInvalid && <p className="mt-1 text-xs text-destructive">Enter 3 to 6 digits.</p>}
            </div>
            {showTrialFilters && (
              <>
                {select('trialId', 'Trial', [{ value: '', label: 'All trials' }, ...trials.map((t) => ({ value: t.id, label: t.condition }))])}
                {select('overallStatus', 'Screening Status', OVERALL_STATUS_OPTIONS)}
              </>
            )}
            {select('formStatus', 'Form Status', FORM_STATUS_OPTIONS)}
          </div>
          <button onClick={loadPreview} disabled={loadingPreview || pinInvalid} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary disabled:opacity-50">
            {loadingPreview ? 'Loading…' : 'Preview Recipients'}
          </button>
          {preview && (
            <div className="rounded-md border border-primary/10 bg-primary/5 px-3 py-2 text-sm text-foreground">
              <p className="font-medium">{audienceSummaryLine(preview.counts)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{preview.counts.sendable} patient{preview.counts.sendable === 1 ? '' : 's'} will receive this message. Opted-out patients and patients without a mobile number are skipped.</p>
            </div>
          )}
          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary">Back</button>
            <button
              onClick={() => setStep(3)}
              disabled={!preview || preview.counts.sendable === 0}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              Next: Review and Send
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-secondary/30 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</p>
            <p className="mt-1 text-sm text-foreground">{message.trim()}</p>
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients</p>
            <p className="mt-1 text-sm text-foreground">{audienceSummaryLine(preview.counts)}</p>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-sm text-muted-foreground">
              {preview.recipients.map((r) => <li key={r.id}>{r.uhid ? `${r.uhid} · ` : ''}{r.name}</li>)}
            </ul>
          </div>
          <div>
            <label htmlFor="broadcast-confirm-count" className={LABEL}>Type {sendable} to confirm the number of recipients</label>
            <input id="broadcast-confirm-count" inputMode="numeric" autoComplete="off" value={typedCount} onChange={(e) => setTypedCount(e.target.value)} className={FIELD} />
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep(2)} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary">Back</button>
            <button onClick={send} disabled={sending || !countConfirmed || sendable === 0} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {sending ? 'Sending…' : `Send to ${sendable} patient${sendable === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
