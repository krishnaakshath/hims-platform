'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function CreateFormButton({ folderId }: { folderId: number | null }) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setCreating(true)
    setError(null)
    try {
      const res = await sendJson<{ id: number }>('/api/form-templates', 'POST', { name: 'Untitled Form', category: 'Uncategorized', diagnosisTag: 'General', questions: [], folderId })
      if (res.ok) {
        const created = res.data
        router.push(`/forms/${created.id}`)
      } else {
        setError(res.error)
      }
    } catch {
      setError('Could not create form. Please check your connection and try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <button onClick={create} disabled={creating} className="rounded-lg border-2 border-dashed border-border p-5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground disabled:opacity-50">
        + Create New Form
      </button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
