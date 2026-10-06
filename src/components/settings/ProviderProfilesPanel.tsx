'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil } from 'lucide-react'

// colorTag stores a design-system chart token name (e.g. "chart-1"), not a
// raw color value -- map it to the matching Tailwind background class.
const COLOR_TAG_CLASS: Record<string, string> = {
  'chart-1': 'bg-chart-1',
  'chart-2': 'bg-chart-2',
  'chart-3': 'bg-chart-3',
  'chart-4': 'bg-chart-4',
  'chart-5': 'bg-chart-5',
}

export interface ProviderRow {
  id: number
  name: string
  credentials: string | null
  specialty: string
  colorTag: string
  isActive: boolean
}

function ProviderRowItem({ provider, isAdmin }: { provider: ProviderRow; isAdmin: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(provider.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/providers/${provider.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    setSaving(false)
    if (!res.ok) { setError('Could not save.'); return }
    setEditing(false)
    // provider.name is a prop from the server-rendered roster -- without
    // this, the row immediately snaps back to displaying the pre-edit name
    // (props haven't changed) even though the rename was persisted, making
    // a successful save look like it silently failed until the next full
    // page load.
    router.refresh()
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${COLOR_TAG_CLASS[provider.colorTag] ?? 'bg-muted-foreground'}`} aria-hidden="true" />
        <div className="min-w-0">
          {editing ? (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-border px-2 py-1 text-sm"
              autoFocus
            />
          ) : (
            <p className="truncate text-sm font-medium text-foreground">{provider.name}{provider.credentials ? `, ${provider.credentials}` : ''}</p>
          )}
          <p className="truncate text-xs text-muted-foreground">{provider.specialty}{!provider.isActive ? ' · Inactive' : ''}</p>
        </div>
      </div>
      {isAdmin && (
        <div className="flex shrink-0 items-center gap-2">
          {error && <span className="text-xs text-destructive">{error}</span>}
          {editing ? (
            <>
              <button onClick={save} disabled={saving} className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => { setEditing(false); setName(provider.name) }} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => setEditing(true)} aria-label={`Edit ${provider.name}`} className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function ProviderProfilesPanel({ providers, isAdmin }: { providers: ProviderRow[]; isAdmin: boolean }) {
  if (providers.length === 0) return <p className="text-sm text-muted-foreground">No providers on file.</p>
  return (
    <div>
      {providers.map((p) => <ProviderRowItem key={p.id} provider={p} isAdmin={isAdmin} />)}
    </div>
  )
}
