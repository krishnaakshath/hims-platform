'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { formatPhoneForDisplay } from '@/lib/patient-directory'
import { PATIENT_LOOKUP_MIN_QUERY, type PatientLookupResult } from '@/lib/queries/search-types'

// Wave C P0-04: the one patient typeahead for every "which patient?" field
// (check-in, booking, pharmacy counter, eligibility). Finds by name, UHID,
// chart id or mobile through GET /api/patients/lookup, which decides what a
// role may see (the mobile only for directory roles). WAI-ARIA combobox:
// labelled input, listbox of options, aria-activedescendant, ArrowUp/Down,
// Enter, Escape. Reports only { id, name, uhid } to the parent.

export interface PickedPatient {
  id: string
  name: string
  uhid: string | null
}

const GENDER_SHORT: Record<string, string> = { male: 'M', female: 'F', transgender: 'TG', other: 'O', unknown: '' }

function detailOf(p: PatientLookupResult): string {
  const ageSex = [p.ageYears !== null ? `${p.ageYears} y` : null, p.gender ? GENDER_SHORT[p.gender] || null : null].filter(Boolean).join(' ')
  return [p.uhid ? `UHID ${p.uhid}` : null, p.id, ageSex || null, p.phone ? formatPhoneForDisplay(p.phone) : null].filter(Boolean).join(' · ')
}

function toPage(data: unknown): { results: PatientLookupResult[]; hasMore: boolean } | null {
  if (!data || typeof data !== 'object') return null
  const d = data as { results?: unknown; hasMore?: unknown }
  if (!Array.isArray(d.results)) return null
  return { results: d.results as PatientLookupResult[], hasMore: d.hasMore === true }
}

export function PatientPicker({
  value,
  onChange,
  label = 'Patient',
  placeholder = 'Name, UHID, mobile or chart ID',
  autoFocus = false,
  disabled = false,
}: {
  value: PickedPatient | null
  onChange: (patient: PickedPatient | null) => void
  label?: string
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
}) {
  const inputId = useId()
  const listId = useId()
  const hintId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PatientLookupResult[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const term = query.trim()
  const searchable = term.length >= PATIENT_LOOKUP_MIN_QUERY

  useEffect(() => {
    if (!searchable) return
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      setLoading(true)
      setFailed(false)
      const url = `/api/patients/lookup?q=${encodeURIComponent(term)}${page > 1 ? `&page=${page}` : ''}`
      fetch(url, { signal: controller.signal })
        .then(async (r) => {
          const parsed = r.ok ? toPage(await r.json().catch(() => null)) : null
          if (!parsed) { setFailed(true); setResults([]); setHasMore(false); return }
          setResults((prev) => (page > 1 ? [...prev, ...parsed.results] : parsed.results))
          setHasMore(parsed.hasMore)
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === 'AbortError') return
          setFailed(true)
          setResults([])
          setHasMore(false)
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, page > 1 ? 0 : 250)
    return () => { clearTimeout(timeout); controller.abort() }
  }, [term, searchable, page])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function select(p: PatientLookupResult) {
    onChange({ id: p.id, name: p.name, uhid: p.uhid })
    setOpen(false)
    setQuery('')
    setResults([])
    setActive(-1)
  }

  function clear() {
    onChange(null)
    setQuery('')
    setResults([])
    setHasMore(false)
    setPage(1)
    setActive(-1)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  if (value) {
    return (
      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className="flex items-center justify-between gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{value.name}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">{value.uhid ? `UHID ${value.uhid} · ` : ''}{value.id}</p>
          </div>
          {!disabled && (
            <button type="button" onClick={clear} aria-label={`Change patient (${value.name})`} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-primary/10">
              <X className="h-3.5 w-3.5" aria-hidden="true" /> Change
            </button>
          )}
        </div>
      </div>
    )
  }

  const expanded = open && searchable
  const optionId = (i: number) => `${listId}-opt-${i}`

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { setOpen(false); setActive(-1); return }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => (results.length === 0 ? -1 : Math.min(i + 1, results.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (expanded && active >= 0 && active < results.length) select(results[active])
    }
  }

  return (
    <div ref={containerRef} className="relative space-y-1">
      <label htmlFor={inputId} className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={hintId}
          aria-activedescendant={expanded && active >= 0 ? optionId(active) : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          disabled={disabled}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setPage(1)
            setActive(-1)
            if (e.target.value.trim().length < PATIENT_LOOKUP_MIN_QUERY) { setResults([]); setHasMore(false); setLoading(false); setFailed(false) }
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none"
        />
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {term.length > 0 && !searchable ? `Type at least ${PATIENT_LOOKUP_MIN_QUERY} characters to search.` : 'Search by name, UHID, mobile number or chart ID.'}
      </p>
      {expanded && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-lg">
          {failed ? (
            <p role="alert" className="p-3 text-sm text-destructive">Patient search is unavailable right now. Please try again.</p>
          ) : results.length === 0 && loading ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">Searching…</p>
          ) : results.length === 0 ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">No patients match. Check the spelling, or register the patient first.</p>
          ) : null}
          <ul id={listId} role="listbox" aria-label={`${label} results`} hidden={failed || results.length === 0}>
            {results.map((p, i) => (
              <li
                key={p.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(p)}
                onMouseEnter={() => setActive(i)}
                className={`cursor-pointer rounded-md px-2 py-1.5 text-sm ${i === active ? 'bg-secondary' : ''}`}
              >
                <span className="block font-medium text-foreground">{p.name}</span>
                <span className="block text-xs text-muted-foreground">{detailOf(p)}</span>
              </li>
            ))}
          </ul>
          {hasMore && !failed && (
            <button type="button" onClick={() => setPage((n) => n + 1)} disabled={loading} className="mt-1 w-full rounded-md px-2 py-1.5 text-center text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50">
              {loading ? 'Loading…' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
