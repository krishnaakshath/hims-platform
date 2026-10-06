'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AttachedConsentRow } from '@/lib/queries/form-template-consents'

export function TemplateConsentsPanel({ templateId, attached, allDocuments }: {
  templateId: number
  attached: AttachedConsentRow[]
  allDocuments: { id: number; name: string }[]
}) {
  const router = useRouter()
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attachedIds = new Set(attached.map((a) => a.consentDocumentId))
  const available = allDocuments.filter((d) => !attachedIds.has(d.id))

  async function attach() {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/form-templates/${templateId}/consents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consentDocumentId: Number(selected) }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error ?? 'Could not attach this consent document.')
        return
      }
      setSelected('')
      router.refresh()
    } catch {
      setError('Could not attach this consent document. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  async function detach(row: AttachedConsentRow) {
    // Detaching a document that already has signatures is allowed and removes
    // only the formTemplateConsents row; existing signatures are untouched.
    // The signed count sits next to the control so the person clicking can see
    // what they are detaching from.
    const ok = window.confirm(
      `Detach "${row.name}"? ${row.signedCount} signature${row.signedCount === 1 ? '' : 's'} already collected stay on record; only the link to this form is removed.`,
    )
    if (!ok) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/form-templates/${templateId}/consents/${row.consentDocumentId}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error ?? 'Could not detach this consent document.')
        return
      }
      router.refresh()
    } catch {
      setError('Could not detach this consent document. Please check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {attached.length === 0 && <p className="text-sm text-muted-foreground">No consent documents attached to this form.</p>}
      {attached.map((row) => (
        <div key={row.consentDocumentId} className="flex items-start justify-between gap-3 rounded-xl border border-primary/10 bg-card/80 p-4 shadow-sm">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{row.name}</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{row.bodyPreview}</p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">{row.legalReviewStatus}</p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs tabular-nums text-muted-foreground">{row.signedCount} signed</span>
            <button onClick={() => detach(row)} disabled={busy} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50">Detach</button>
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 pt-1">
        <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Consent document to attach" className="flex-1 rounded-md border border-border px-3 py-2 text-sm">
          <option value="">Select a consent document…</option>
          {available.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <button onClick={attach} disabled={busy || !selected} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground hover:opacity-90 disabled:opacity-50">Attach</button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  )
}
