'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { MarkProcessedButton } from '@/components/MarkProcessedButton'

export function DocumentRowActions({ documentId, documentName, status, fileUrl, canWrite, canDelete }: {
  documentId: number
  documentName: string
  status: 'new' | 'processed'
  fileUrl: string | null
  canWrite: boolean
  canDelete: boolean
}) {
  const router = useRouter()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    if (!window.confirm(`Delete "${documentName}"? This cannot be undone.`)) return
    setDeleting(true)
    setError(null)
    const res = await fetch(`/api/documents/${documentId}`, { method: 'DELETE' })
    setDeleting(false)
    if (res.ok) { router.refresh(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not delete this document.')
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {canWrite && <MarkProcessedButton documentId={documentId} disabled={status === 'processed'} />}
        {fileUrl ? (
          <a href={`/api/documents/${documentId}/download`} className="text-xs font-medium text-primary hover:underline">
            Download
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">No file</span>
        )}
        {canDelete && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-1 rounded-md border border-destructive/30 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Delete
          </button>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
