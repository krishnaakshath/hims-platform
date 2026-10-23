'use client'
// WS4 T12: the actions on a critical alert -- the lab's call log (POST .../critical/notify) and the
// doctor's acknowledgement (POST .../critical/acknowledge). A failure is always shown, never swallowed.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'

const CHANNEL_LABEL = { phone: 'Phone', in_person: 'In person', in_app: 'In the app' } as const
type Channel = keyof typeof CHANNEL_LABEL

const buttonClass = 'rounded bg-destructive/10 px-2 py-1 text-[11px] font-bold uppercase text-destructive hover:bg-destructive/20 disabled:opacity-50'

export function CriticalNotifyForm({ orderId, testName }: { orderId: number; testName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<Channel>('phone')
  const [readBack, setReadBack] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (name.trim() === '') { setError('Enter who was called.'); return }
    if (channel === 'phone' && !readBack) { setError('A critical result given by phone must be read back by the person receiving it.'); return }
    setBusy(true)
    const res = await sendJson(`/api/lab-orders/${orderId}/critical/notify`, 'POST', { notifiedToName: name.trim(), channel, readBack })
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return <button type="button" className={buttonClass} aria-label={`Log the call for ${testName}`} onClick={() => setOpen(true)}>Log call</button>
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 text-xs" aria-label={`Log the call for ${testName}`}>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">Called (doctor or nurse)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className="rounded border border-border bg-background px-2 py-1" />
      </label>
      <label className="flex flex-col gap-0.5">
        <span className="text-muted-foreground">How</span>
        <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className="rounded border border-border bg-background px-2 py-1">
          {(Object.keys(CHANNEL_LABEL) as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1">
        <input type="checkbox" checked={readBack} onChange={(e) => setReadBack(e.target.checked)} />
        <span>Value read back</span>
      </label>
      <button type="submit" disabled={busy} className={buttonClass}>Save call</button>
      <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground underline">Cancel</button>
      {error && <span role="alert" className="w-full text-destructive">{error}</span>}
    </form>
  )
}

export function CriticalAcknowledgeButton({ orderId, testName }: { orderId: number; testName: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function acknowledge() {
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/lab-orders/${orderId}/critical/acknowledge`, 'POST', {})
    setBusy(false)
    if (!res.ok) { setError(res.error); return }
    router.refresh()
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <button type="button" onClick={acknowledge} disabled={busy} aria-label={`Acknowledge critical ${testName}`} className={buttonClass}>Acknowledge</button>
      {error && <span role="alert" className="max-w-[14rem] text-right text-[11px] text-destructive">{error}</span>}
    </span>
  )
}
