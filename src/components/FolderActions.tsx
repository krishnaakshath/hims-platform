'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'

export function FolderActions({ folder, templateCount }: { folder: { id: number; name: string }; templateCount: number }) {
  const router = useRouter()
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(folder.name)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function rename() {
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/form-template-folders/${folder.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (res.ok) {
        setRenaming(false)
        router.refresh()
      } else {
        setError('Could not rename folder. Please try again.')
      }
    } catch {
      setError('Could not rename folder. Please check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    const confirmed = window.confirm(
      `Delete this folder? The ${templateCount} form${templateCount === 1 ? '' : 's'} in it will be moved out of the folder, not deleted.`,
    )
    if (!confirmed) return
    setDeleting(true)
    setError(null)
    try {
      const res = await fetch(`/api/form-template-folders/${folder.id}`, { method: 'DELETE' })
      if (res.ok) {
        router.push('/forms')
      } else {
        setError('Could not delete folder. Please try again.')
      }
    } catch {
      setError('Could not delete folder. Please check your connection and try again.')
    } finally {
      setDeleting(false)
    }
  }

  if (renaming) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename()
              if (e.key === 'Escape') { setRenaming(false); setName(folder.name); setError(null) }
            }}
            disabled={saving}
            aria-label="Folder name"
            className="max-w-xs"
          />
          <button
            onClick={rename}
            disabled={saving || !name.trim()}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => { setRenaming(false); setName(folder.name); setError(null) }}
            disabled={saving}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setRenaming(true)}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Rename
        </button>
        <button
          onClick={remove}
          disabled={deleting}
          className="flex items-center gap-1.5 rounded-md border border-destructive/30 px-2.5 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
