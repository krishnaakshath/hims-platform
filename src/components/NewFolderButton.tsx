'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'

export function NewFolderButton() {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    if (!name.trim()) return
    setCreating(true)
    setError(null)
    try {
      const res = await fetch('/api/form-template-folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      })
      if (res.ok) {
        setEditing(false)
        setName('')
        router.refresh()
      } else {
        setError('Could not create folder. Please try again.')
      }
    } catch {
      setError('Could not create folder. Please check your connection and try again.')
    } finally {
      setCreating(false)
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border-2 border-dashed border-border p-5">
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') create()
            if (e.key === 'Escape') { setEditing(false); setName(''); setError(null) }
          }}
          placeholder="Folder name"
          aria-label="New folder name"
          disabled={creating}
        />
        <div className="flex gap-2">
          <button
            onClick={create}
            disabled={creating || !name.trim()}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button
            onClick={() => { setEditing(false); setName(''); setError(null) }}
            disabled={creating}
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
    <button
      onClick={() => setEditing(true)}
      className="rounded-lg border-2 border-dashed border-border p-5 text-sm font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
    >
      + New Folder
    </button>
  )
}
