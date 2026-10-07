'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Department } from '@/db/schema'

const KINDS: Department['kind'][] = ['clinical', 'diagnostic', 'support', 'administrative']
const INPUT = 'rounded-md border border-border px-3 py-2 text-sm'

export function DepartmentsPanel({ departments, isAdmin }: { departments: Department[]; isAdmin: boolean }) {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Department['kind']>('clinical')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function add() {
    setBusy(true)
    setError(null)
    const res = await fetch('/api/departments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name, kind }),
    })
    setBusy(false)
    if (res.status === 409) { setError('Department code already exists.'); return }
    if (!res.ok) { setError('Could not add department.'); return }
    setCode(''); setName('')
    router.refresh()
  }

  async function toggle(d: Department) {
    setError(null)
    const res = await fetch(`/api/departments/${d.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !d.isActive }),
    })
    if (!res.ok) { setError('Could not update department.'); return }
    router.refresh()
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border">
        {departments.map((d) => (
          <li key={d.id} className="flex items-center justify-between gap-3 py-2 text-sm">
            <div>
              <span className="font-medium text-foreground">{d.name}</span>
              <span className="ml-2 font-mono text-xs text-muted-foreground">{d.code}</span>
              <span className="ml-2 text-xs capitalize text-muted-foreground">{d.kind}</span>
              {!d.isActive && <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Inactive</span>}
            </div>
            {isAdmin && (
              <button onClick={() => toggle(d)} className="text-xs font-medium text-primary hover:underline">
                {d.isActive ? 'Deactivate' : 'Activate'}
              </button>
            )}
          </li>
        ))}
        {departments.length === 0 && <li className="py-2 text-sm text-muted-foreground">No departments yet.</li>}
      </ul>
      {isAdmin && (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Department code" placeholder="Code" value={code} maxLength={16} onChange={(e) => setCode(e.target.value.toUpperCase())} className={`${INPUT} w-28 font-mono`} />
            <input aria-label="Department name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className={`${INPUT} min-w-0 flex-1`} />
            <select aria-label="Department kind" value={kind} onChange={(e) => setKind(e.target.value as Department['kind'])} className={`${INPUT} capitalize`}>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={add} disabled={busy || !code || !name.trim()} className="rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
              {busy ? 'Adding…' : 'Add department'}
            </button>
            {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
          </div>
        </div>
      )}
      {!isAdmin && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
