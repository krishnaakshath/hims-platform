'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// WS8 T14 (spec D18): log a new DPDP data-principal request. Due 30 days after the date received.
const KINDS = [
  ['access', 'Access (copy of records)'],
  ['correction', 'Correction'],
  ['erasure', 'Erasure'],
  ['grievance', 'Grievance'],
] as const
const VIA = [
  ['email', 'Email'],
  ['portal_message', 'Portal message'],
  ['letter', 'Letter'],
  ['in_person', 'In person'],
] as const

const SELECT = 'h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm'

export function DataRequestCreateForm({ todayIso }: { todayIso: string }) {
  const router = useRouter()
  const [patientRef, setPatientRef] = useState('')
  const [kind, setKind] = useState<(typeof KINDS)[number][0]>('access')
  const [receivedVia, setReceivedVia] = useState<(typeof VIA)[number][0]>('email')
  const [receivedAt, setReceivedAt] = useState(todayIso)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = { ref: useId(), kind: useId(), via: useId(), at: useId(), note: useId() }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const res = await sendJson<{ id: number }>('/api/governance/data-requests', 'POST', {
      patientRef: patientRef.trim(),
      kind,
      receivedVia,
      receivedAt,
      ...(note.trim() ? { note: note.trim() } : {}),
    })
    setSaving(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    router.push(`/governance/data-requests/${res.data.id}`)
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="space-y-1">
        <label htmlFor={ids.ref} className="text-sm font-medium text-foreground">Patient UHID</label>
        <Input id={ids.ref} value={patientRef} onChange={(e) => setPatientRef(e.target.value)} autoComplete="off" spellCheck={false} maxLength={64} required />
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.kind} className="text-sm font-medium text-foreground">Request</label>
        <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={SELECT}>
          {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.via} className="text-sm font-medium text-foreground">Received by</label>
        <select id={ids.via} value={receivedVia} onChange={(e) => setReceivedVia(e.target.value as typeof receivedVia)} className={SELECT}>
          {VIA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={ids.at} className="text-sm font-medium text-foreground">Date received</label>
        <Input id={ids.at} type="date" value={receivedAt} max={todayIso} onChange={(e) => setReceivedAt(e.target.value)} required />
      </div>
      <div className="space-y-1 sm:col-span-2 lg:col-span-4">
        <label htmlFor={ids.note} className="text-sm font-medium text-foreground">Note (optional)</label>
        <Input id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2 lg:col-span-4">
        <Button type="submit" disabled={saving || patientRef.trim() === '' || receivedAt === ''}>{saving ? 'Saving…' : 'Log request'}</Button>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>
    </form>
  )
}
