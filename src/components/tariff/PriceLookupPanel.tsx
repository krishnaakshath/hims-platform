'use client'
import { useEffect, useId, useState } from 'react'
import { FIELD_CLASS, formatIsoDate } from '@/components/tariff/api'
import { fetchJson } from '@/lib/client-fetch'

interface ServiceOption { id: number; code: string; name: string; departmentName?: string | null }
interface RoomCategoryOption { id: number; code: string; name: string }
interface DepartmentOption { id: number; name: string; isActive?: boolean }
interface SheetRow {
  rateId: number
  scope: 'base' | 'department' | 'payer'
  departmentName: string | null
  payerName: string | null
  roomCategoryCode: string | null
  roomCategoryName: string | null
  ward: string | null
  formatted: string
  validFrom: string
  validTo: string | null
}
interface PriceSheet {
  service: { id: number; code: string; name: string; departmentName: string; gstRateBp: number; hsnSac: string }
  rows: SheetRow[]
  payers: { id: number; name: string }[]
  departments: { id: number; name: string }[]
  wards: string[]
}
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

function appliesTo(r: SheetRow): string {
  const parts = [r.roomCategoryName ?? r.roomCategoryCode, r.ward ? `Ward: ${r.ward}` : null].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : 'Any room (outpatient / general)'
}

// Wave B P1-05: service search -> date + room category -> GET /api/tariff/resolve.
// Wave G P1-05: department filter on the search, the rate card for the chosen
// service and date (GET /api/tariff/services/[id]/price-sheet), and payer /
// ordering department / ward on the resolver. `initialService` comes from a
// global search hit (/price-lookup?serviceId=).
export function PriceLookupPanel({ today, initialService = null }: { today: string; initialService?: ServiceOption | null }) {
  const ids = {
    service: useId(), date: useId(), room: useId(), list: useId(), searchDept: useId(),
    payer: useId(), dept: useId(), ward: useId(), card: useId(),
  }
  const [query, setQuery] = useState(initialService?.name ?? '')
  const [searchDept, setSearchDept] = useState('')
  const [options, setOptions] = useState<ServiceOption[]>([])
  const [activeOption, setActiveOption] = useState(-1)
  const [service, setService] = useState<ServiceOption | null>(initialService)
  const [onDate, setOnDate] = useState(today)
  const [roomCategories, setRoomCategories] = useState<RoomCategoryOption[]>([])
  const [allDepartments, setAllDepartments] = useState<DepartmentOption[]>([])
  const [roomCategory, setRoomCategory] = useState('')
  const [payerId, setPayerId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [ward, setWard] = useState('')
  const [sheet, setSheet] = useState<PriceSheet | null>(null)
  const [sheetError, setSheetError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Resolved | null>(null)

  useEffect(() => {
    void fetchJson<{ roomCategories: RoomCategoryOption[] }>('/api/tariff/room-categories').then((r) => {
      if (r.ok) setRoomCategories(r.data?.roomCategories ?? [])
    })
    void fetchJson<DepartmentOption[]>('/api/departments?active=1').then((r) => {
      if (r.ok && Array.isArray(r.data)) setAllDepartments(r.data.filter((d) => d.isActive !== false))
    })
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2 || (service && q === service.name)) return
    const controller = new AbortController()
    const t = setTimeout(() => {
      const params = new URLSearchParams({ q: q.slice(0, 100) })
      if (searchDept) params.set('departmentId', searchDept)
      void fetchJson<{ services: ServiceOption[] }>(`/api/tariff/services?${params.toString()}`, { signal: controller.signal }).then((r) => {
        if (controller.signal.aborted) return
        setOptions(r.ok ? (r.data?.services ?? []).slice(0, 8) : [])
        setActiveOption(-1)
      })
    }, 200)
    return () => { clearTimeout(t); controller.abort() }
  }, [query, service, searchDept])

  // The rate card follows the chosen service and date.
  useEffect(() => {
    if (!service || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return
    const controller = new AbortController()
    void fetchJson<PriceSheet>(`/api/tariff/services/${service.id}/price-sheet?onDate=${onDate}`, { signal: controller.signal }).then((r) => {
      if (controller.signal.aborted) return
      if (r.ok && r.data) { setSheet(r.data); setSheetError(null) }
      else { setSheet(null); setSheetError(r.ok ? null : r.error) }
    })
    return () => controller.abort()
  }, [service, onDate])

  function choose(s: ServiceOption) {
    setService(s)
    setQuery(s.name)
    setOptions([])
    setActiveOption(-1)
    setResult(null)
    setSheet(null)
    setSheetError(null)
    setPayerId('')
    setDepartmentId('')
    setWard('')
  }

  function onServiceKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (options.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setActiveOption((i) => (i + 1) % options.length) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveOption((i) => (i <= 0 ? options.length - 1 : i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(options[activeOption >= 0 ? activeOption : 0]) }
    else if (e.key === 'Escape') { e.preventDefault(); setOptions([]); setActiveOption(-1) }
  }

  async function lookUp(e: React.FormEvent) {
    e.preventDefault()
    if (!service) return
    setBusy(true)
    setError(null)
    setResult(null)
    const params = new URLSearchParams({ serviceId: String(service.id), onDate })
    if (roomCategory) params.set('roomCategory', roomCategory)
    if (payerId) params.set('payerId', payerId)
    if (departmentId) params.set('departmentId', departmentId)
    if (ward) params.set('ward', ward)
    const r = await fetchJson<Resolved>(`/api/tariff/resolve?${params.toString()}`)
    setBusy(false)
    if (r.ok && r.data) setResult(r.data)
    else setError(r.ok ? 'Something went wrong. Please try again.' : r.error)
  }

  const optionId = (i: number) => `${ids.list}-opt-${i}`
  const clearResult = () => setResult(null)

  return (
    <div className="space-y-6">
      <form onSubmit={lookUp} className="space-y-4 rounded-md border border-border bg-card p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="relative sm:col-span-2">
            <label htmlFor={ids.service} className="mb-1 block text-sm font-medium text-foreground">Service</label>
            <input
              id={ids.service}
              type="text"
              role="combobox"
              aria-expanded={options.length > 0}
              aria-controls={ids.list}
              aria-autocomplete="list"
              aria-activedescendant={activeOption >= 0 && options.length > 0 ? optionId(activeOption) : undefined}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setService(null); setSheet(null); setResult(null); if (e.target.value.trim().length < 2) setOptions([]) }}
              onKeyDown={onServiceKeyDown}
              placeholder="Type a service name or code"
              autoComplete="off"
              className={FIELD_CLASS}
            />
            {options.length > 0 && (
              <ul id={ids.list} role="listbox" aria-label="Matching services" className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-border bg-card p-1 shadow-lg">
                {options.map((s, i) => (
                  <li
                    key={s.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === activeOption}
                    onMouseEnter={() => setActiveOption(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(s)}
                    className={`flex cursor-pointer items-baseline justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-secondary ${i === activeOption ? 'bg-secondary' : ''}`}
                  >
                    <span className="font-medium text-foreground">{s.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{s.departmentName ? `${s.code} · ${s.departmentName}` : s.code}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <label htmlFor={ids.searchDept} className="mb-1 block text-sm font-medium text-foreground">Search in department</label>
            <select id={ids.searchDept} value={searchDept} onChange={(e) => setSearchDept(e.target.value)} className={FIELD_CLASS}>
              <option value="">All departments</option>
              {allDepartments.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.date} className="mb-1 block text-sm font-medium text-foreground">Date</label>
            <input id={ids.date} type="date" value={onDate} onChange={(e) => { setOnDate(e.target.value); clearResult() }} required className={FIELD_CLASS} />
          </div>
          <div>
            <label htmlFor={ids.room} className="mb-1 block text-sm font-medium text-foreground">Room category</label>
            <select id={ids.room} value={roomCategory} onChange={(e) => { setRoomCategory(e.target.value); clearResult() }} className={FIELD_CLASS}>
              <option value="">Any (outpatient / general)</option>
              {roomCategories.map((c) => <option key={c.id} value={c.code}>{c.name}</option>)}
            </select>
          </div>
          {sheet && sheet.wards.length > 0 && (
            <div>
              <label htmlFor={ids.ward} className="mb-1 block text-sm font-medium text-foreground">Ward</label>
              <select id={ids.ward} value={ward} onChange={(e) => { setWard(e.target.value); clearResult() }} className={FIELD_CLASS}>
                <option value="">Any ward</option>
                {sheet.wards.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
          )}
          {sheet && sheet.departments.length > 0 && (
            <div>
              <label htmlFor={ids.dept} className="mb-1 block text-sm font-medium text-foreground">Ordering department</label>
              <select id={ids.dept} value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); clearResult() }} className={FIELD_CLASS}>
                <option value="">{`The service's own (${sheet.service.departmentName})`}</option>
                {sheet.departments.map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
              </select>
            </div>
          )}
          {sheet && sheet.payers.length > 0 && (
            <div>
              <label htmlFor={ids.payer} className="mb-1 block text-sm font-medium text-foreground">Payer</label>
              <select id={ids.payer} value={payerId} onChange={(e) => { setPayerId(e.target.value); clearResult() }} className={FIELD_CLASS}>
                <option value="">Self-pay / no payer rate</option>
                {sheet.payers.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
              </select>
            </div>
          )}
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

      {service && sheetError && <p className="text-sm text-destructive">Could not load the price list: {sheetError}</p>}
      {sheet && (
        <section aria-labelledby={ids.card} className="rounded-md border border-border bg-card p-5">
          <h2 id={ids.card} className="text-base font-semibold text-foreground">Rates in force on {formatIsoDate(onDate)}</h2>
          <p className="mb-3 text-xs text-muted-foreground">
            {sheet.service.name} ({sheet.service.code}) · {sheet.service.departmentName} · GST {sheet.service.gstRateBp / 100}% · HSN/SAC {sheet.service.hsnSac}.
            {' '}A payer rate wins over a department rate, which wins over the base rate; within one, the most specific room / ward match wins.
          </p>
          {sheet.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rate is set for this service on that date.</p>
          ) : (
            <div className="overflow-x-auto">
              <table aria-labelledby={ids.card} className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1.5 pr-3 font-semibold">Rate</th>
                    <th scope="col" className="py-1.5 pr-3 font-semibold">For</th>
                    <th scope="col" className="py-1.5 pr-3 font-semibold">Room / ward</th>
                    <th scope="col" className="py-1.5 pr-3 text-right font-semibold">Price</th>
                    <th scope="col" className="py-1.5 font-semibold">Valid</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.rows.map((r) => (
                    <tr key={r.rateId} className="border-t border-border">
                      <td className="py-1.5 pr-3 text-foreground">{SCOPE_TEXT[r.scope]}</td>
                      <td className="py-1.5 pr-3 text-foreground">{r.payerName ?? r.departmentName ?? 'Everyone'}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground">{appliesTo(r)}</td>
                      <td className="py-1.5 pr-3 text-right font-medium tabular-nums text-foreground">{r.formatted}</td>
                      <td className="py-1.5 text-xs text-muted-foreground">{formatIsoDate(r.validFrom)} – {r.validTo ? formatIsoDate(r.validTo) : 'open'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
