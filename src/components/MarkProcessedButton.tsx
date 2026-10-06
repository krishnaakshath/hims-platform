'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function MarkProcessedButton({ documentId, disabled }: { documentId: number; disabled: boolean }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function markProcessed() {
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/documents/${documentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'processed' }),
    })
    setSaving(false)
    if (res.ok) {
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not mark this document processed.')
    }
  }

  if (disabled) return <span className="text-xs text-muted-foreground">Processed</span>

  return (
    <div>
      <button onClick={markProcessed} disabled={saving} className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50">
        {saving ? 'Saving…' : 'Mark Processed'}
      </button>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
