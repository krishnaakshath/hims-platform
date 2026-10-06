'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'

export function NewConsentDocumentButton() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [bodyText, setBodyText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    if (!name.trim() || !bodyText.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/consent-documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), bodyText }),
      })
      if (res.ok) {
        const created = await res.json()
        router.push('/consent-documents/' + created.id)
      } else {
        setError('Could not create consent document. Please try again.')
      }
    } catch {
      setError('Could not create consent document. Please check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground">
        + New Consent Document
      </button>
    )
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Document name" aria-label="Document name" disabled={saving} />
      <textarea
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        placeholder="Consent wording"
        aria-label="Consent wording"
        rows={6}
        disabled={saving}
        className="rounded-md border border-border bg-background p-2 text-sm"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <button onClick={create} disabled={saving || !name.trim() || !bodyText.trim()} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {saving ? 'Creating…' : 'Create'}
        </button>
        <button onClick={() => { setOpen(false); setError(null) }} disabled={saving} className="rounded-md border border-border px-3 py-1.5 text-sm">
          Cancel
        </button>
      </div>
    </div>
  )
}
