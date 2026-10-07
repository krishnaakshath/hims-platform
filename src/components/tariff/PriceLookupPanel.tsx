'use client'
import { useEffect, useId, useState } from 'react'
import { FIELD_CLASS, formatIsoDate } from '@/components/tariff/api'

interface ServiceOption { id: number; code: string; name: string; departmentName?: string | null }
interface RoomCategoryOption { id: number; code: string; name: string }
type Resolved =
  | { ok: true; serviceCode: string; serviceName: string; formatted: string; gstRateBp: number; hsnSac: string | null; scope: 'base' | 'department' | 'payer'; matched: { roomCategory: string | null; ward: string | null } }
  | { ok: false; reason: 'invalid_date' | 'service_not_found' | 'service_inactive' | 'no_rate' }

const REASON_TEXT: Record<string, string> = {
  invalid_date: 'That date is not valid.',
  service_not_found: 'That service is not in the catalogue.',
  service_inactive: 'That service is no longer offered.',
  no_rate: 'No price is set for this service on that date.',
}
const SCOPE_TEXT: Record<string, string> = { base: 'Base rate', department: 'Department rate', payer: 'Payer rate' }

async function getJson<T>(url: string, signal?: AbortSignal): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { signal })
    const data = await res.json().catch(() => null)
    if (res.ok && data) return { ok: true, data: data as T }
    return { ok: false, error: data && typeof data.error === 'string' && data.error ? data.error : 'Something went wrong. Please try again.' }
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err
    return { ok: false, error: 'Could not reach the server. Check your connection and try again.' }
  }
}

// Wave B P1-05: service search -> date + room category -> GET /api/tariff/resolve.
export function PriceLookupPanel({ today }: { today: string }) {
  const ids = { service: useId(), date: useId(), room: useId(), list: useId() }
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<ServiceOption[]>([])
  const [service, setService] = useState<ServiceOption | null>(null)
  const [onDate, setOnDate] = useState(today)
  const [roomCategories, setRoomCategories] = useState<RoomCategoryOption[]>([])
  const [roomCategory, setRoomCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Resolved | null>(null)

  useEffect(() => {
    getJson<{ roomCategories: RoomCategoryOption[] }>('/api/tariff/room-categories')
      .then((r) => { if (r.ok) setRoomCategories(r.data.roomCategories ?? []) })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || (service && q === service.name)) return
    const controller = new AbortController()
    const t = setTimeout(() => {
      getJson<{ services: ServiceOption[] }>(`/api/tariff/services?q=${encodeURIComponent(q.slice(0, 100))}`, controller.signal)
        .then((r) => setOptions(r.ok ? (r.data.services ?? []).slice(0, 8) : []))
        .catch(() => undefined)
    }, 200)
    return () => { clearTimeout(t); controller.abort() }
  }, [query, service])

  function choose(s: ServiceOption) {
    setService(s)
    setQuery(s.name)
    setOptions([])
    setResult(null)
  }

  async function lookUp(e: React.FormEvent) {
    e.preventDefault()
    if (!service) return
    setBusy(true)
    setError(null)
    setResult(null)
    const params = new URLSearchParams({ serviceId: String(service.id), onDate })
    if (roomCategory) params.set('roomCategory', roomCategory)
    const r = await getJson<Resolved>(`/api/tariff/resolve?${params.toString()}`).catch(() => ({ ok: false as const, error: 'Something went wrong. Please try again.' }))
    setBusy(false)
    if (r.ok) setResult(r.data)
    else setError(r.error)
  }

  return (
    <form onSubmit={lookUp} className="space-y-4 rounded-md border border-border bg-card p-5">
      <div className="relative">
        <label htmlFor={ids.service} className="mb-1 block text-sm font-medium text-foreground">Service</label>
        <input
          id={ids.service}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setService(null); setResult(null); if (e.target.value.trim().length < 2) setOptions([]) }}
          placeholder="Type a service name or code"
          autoComplete="off"
          aria-describedby={options.length > 0 ? ids.list : undefined}
          className={FIELD_CLASS}
        />
        {options.length > 0 && (
          <ul id={ids.list} aria-label="Matching services" className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg">
            {options.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => choose(s)} className="flex w-full items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-secondary focus:bg-secondary focus:outline-none">
                  <span className="font-medium text-foreground">{s.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{s.code}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.date} className="mb-1 block text-sm font-medium text-foreground">Date</label>
          <input id={ids.date} type="date" value={onDate} onChange={(e) => { setOnDate(e.target.value); setResult(null) }} required className={FIELD_CLASS} />
        </div>
        <div>
          <label htmlFor={ids.room} className="mb-1 block text-sm font-medium text-foreground">Room category</label>
          <select id={ids.room} value={roomCategory} onChange={(e) => { setRoomCategory(e.target.value); setResult(null) }} className={FIELD_CLASS}>
            <option value="">Any (outpatient / general)</option>
            {roomCategories.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
          </select>
        </div>
      </div>
      <button type="submit" disabled={!service || !onDate || busy} className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">
        {busy ? 'Looking up…' : 'Look up price'}
      </button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {result && (
        <div role="status" className="rounded-md border border-border bg-muted/40 p-4">
          {result.ok ? (
            <>
              <p className="text-sm text-muted-foreground">{result.serviceName} ({result.serviceCode}) on {formatIsoDate(onDate)}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{result.formatted}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {SCOPE_TEXT[result.scope] ?? result.scope}
                {result.matched.roomCategory ? ` · ${result.matched.roomCategory}` : ''}
                {` · GST ${result.gstRateBp / 100}%`}
                {result.hsnSac ? ` · HSN/SAC ${result.hsnSac}` : ''}
              </p>
            </>
          ) : (
            <p className="text-sm text-foreground">{REASON_TEXT[result.reason] ?? 'No price found.'}</p>
          )}
        </div>
      )}
    </form>
  )
}
