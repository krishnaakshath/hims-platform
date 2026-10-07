'use client'
import { sendJson } from '@/lib/client-fetch'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil } from 'lucide-react'
import type { Department } from '@/db/schema'
import { INDIAN_STATES } from '@/lib/india/reference'
import { formatPaise, parseRupeesToPaise } from '@/lib/money'

const INPUT = 'w-full rounded-md border border-border px-2 py-1 text-sm'

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
  departmentId: number | null
  registrationCouncil: 'nmc' | 'smc' | null
  registrationStateCode: string | null
  registrationNumber: string | null
  consultationFeePaise: number | null
}

function ProviderRowItem({ provider, departments, isAdmin }: { provider: ProviderRow; departments: Department[]; isAdmin: boolean }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(provider.name)
  const [departmentId, setDepartmentId] = useState(provider.departmentId != null ? String(provider.departmentId) : '')
  const [council, setCouncil] = useState<string>(provider.registrationCouncil ?? '')
  const [stateCode, setStateCode] = useState(provider.registrationStateCode ?? '')
  const [regNumber, setRegNumber] = useState(provider.registrationNumber ?? '')
  const [fee, setFee] = useState(provider.consultationFeePaise != null ? (provider.consultationFeePaise / 100).toFixed(2) : '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setError(null)
    let consultationFeePaise: number | null = null
    if (fee.trim() !== '') {
      consultationFeePaise = parseRupeesToPaise(fee)
      if (consultationFeePaise === null) { setError('Enter a valid fee in rupees.'); return }
    }
    setSaving(true)
    const res = await sendJson(`/api/providers/${provider.id}`, 'PUT', {
      name,
      departmentId: departmentId === '' ? null : Number(departmentId),
      registrationCouncil: council === '' ? null : council,
      registrationStateCode: council === 'smc' ? stateCode || null : null,
      registrationNumber: regNumber.trim() === '' ? null : regNumber.trim(),
      consultationFeePaise,
    })
    setSaving(false)
    if (res.status === 409) { setError('Conflicts with an existing provider.'); return }
    if (!res.ok) { setError(res.error); return }
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
          <p className="truncate text-xs text-muted-foreground">
            {provider.specialty}
            {provider.consultationFeePaise != null ? ` · ${formatPaise(provider.consultationFeePaise)}` : ''}
            {!provider.isActive ? ' · Inactive' : ''}
          </p>
          {editing && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted-foreground">Department
                <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} className={INPUT}>
                  <option value="">None</option>
                  {departments.filter((d) => d.isActive || String(d.id) === departmentId).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              <label className="text-xs text-muted-foreground">Registration council
                <select value={council} onChange={(e) => setCouncil(e.target.value)} className={INPUT}>
                  <option value="">None</option>
                  <option value="nmc">National Medical Commission</option>
                  <option value="smc">State Medical Council</option>
                </select>
              </label>
              {council === 'smc' && (
                <label className="text-xs text-muted-foreground">Registration state
                  <select value={stateCode} onChange={(e) => setStateCode(e.target.value)} className={INPUT}>
                    <option value="">Select state</option>
                    {INDIAN_STATES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                  </select>
                </label>
              )}
              <label className="text-xs text-muted-foreground">Registration number
                <input value={regNumber} onChange={(e) => setRegNumber(e.target.value)} maxLength={20} autoComplete="off" className={INPUT} />
              </label>
              <label className="text-xs text-muted-foreground">Consultation fee (₹)
                <input value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" className={INPUT} />
              </label>
            </div>
          )}
        </div>
      </div>
      {isAdmin && (
        <div className="flex shrink-0 items-center gap-2">
          {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
          {editing ? (
            <>
              <button onClick={save} disabled={saving} className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => { setEditing(false); setName(provider.name); setError(null) }} className="text-xs font-medium text-muted-foreground hover:text-foreground">
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

export function ProviderProfilesPanel({ providers, departments, isAdmin }: { providers: ProviderRow[]; departments: Department[]; isAdmin: boolean }) {
  if (providers.length === 0) return <p className="text-sm text-muted-foreground">No providers on file.</p>
  return (
    <div>
      {providers.map((p) => <ProviderRowItem key={p.id} provider={p} departments={departments} isAdmin={isAdmin} />)}
    </div>
  )
}
