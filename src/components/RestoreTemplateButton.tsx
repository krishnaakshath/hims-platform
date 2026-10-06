'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RestoreTemplateButton({ templateId }: { templateId: number }) {
  const router = useRouter()
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function restore() {
    setRestoring(true)
    setError(null)
    try {
      const res = await fetch(`/api/form-templates/${templateId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: true }),
      })
      if (res.ok) {
        router.refresh()
      } else {
        setError('Could not restore this form. Please try again.')
      }
    } catch {
      setError('Could not restore this form. Please check your connection and try again.')
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={restore}
        disabled={restoring}
        className="rounded-md border border-border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        {restoring ? 'Restoring…' : 'Restore'}
      </button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
