'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import type { ConsentDocumentRow, LegalReviewStatus } from '@/lib/queries/consent-documents'

export function ConsentDocumentEditor({ document }: { document: ConsentDocumentRow }) {
  const router = useRouter()
  const [name, setName] = useState(document.name)
  const [bodyText, setBodyText] = useState(document.bodyText)
  const [status, setStatus] = useState<LegalReviewStatus>(document.legalReviewStatus)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function save() {
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/consent-documents/${document.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), bodyText, legalReviewStatus: status }),
      })
      if (res.ok) {
        setMessage({ kind: 'ok', text: 'Saved.' })
        router.refresh()
      } else {
        setMessage({ kind: 'error', text: 'Could not save. Check that name and wording are not empty.' })
      }
    } catch {
      setMessage({ kind: 'error', text: 'Could not save. Please check your connection and try again.' })
    } finally {
      setSaving(false)
    }
  }

  const n = document.signedCount
  return (
    <div className="max-w-2xl space-y-4">
      {n > 0 && (
        <p className="rounded-md border border-border bg-muted p-3 text-sm text-foreground">
          {n} {n === 1 ? 'signature' : 'signatures'} recorded against earlier wording — editing this text does not change what those people agreed to.
        </p>
      )}
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">Name</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">Wording</span>
        <textarea
          value={bodyText}
          onChange={(e) => setBodyText(e.target.value)}
          rows={12}
          disabled={saving}
          className="w-full rounded-md border border-border bg-background p-2 text-sm"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-foreground">Legal review status</span>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as LegalReviewStatus)}
          disabled={saving}
          className="block rounded-md border border-border bg-background p-2 text-sm"
        >
          <option value="draft">Draft (not yet reviewed by legal counsel)</option>
          <option value="reviewed">Reviewed</option>
        </select>
      </label>
      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving || !name.trim() || !bodyText.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {message && <p className={message.kind === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{message.text}</p>}
      </div>
    </div>
  )
}
