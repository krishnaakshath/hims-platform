'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function MarkProcessedButton({ documentId, disabled }: { documentId: number; disabled: boolean }) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function markProcessed() {
    setSaving(true)
    setError(null)
    const res = await sendJson(`/api/documents/${documentId}`, 'PATCH', { status: 'processed' })
    setSaving(false)
    if (res.ok) {
      router.refresh()
    } else {
      setError(res.error)
    }
  }

  if (disabled) return <span className="text-xs text-muted-foreground">Processed</span>

  return (
    <div>
      <button onClick={markProcessed} disabled={saving} className="rounded-md border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-secondary disabled:opacity-50">
        {saving ? 'Saving…' : 'Mark Processed'}
      </button>
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
