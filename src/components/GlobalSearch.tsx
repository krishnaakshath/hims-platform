'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { EMPTY_SEARCH_RESULTS, type SearchResults } from '@/lib/queries/search-types'

const SECTIONS: { key: keyof SearchResults; label: string }[] = [
  { key: 'patients', label: 'Patients' },
  { key: 'trials', label: 'Trials & Protocols' },
  { key: 'formTemplates', label: 'Form Templates' },
  { key: 'services', label: 'Services' },
]

// Accept only the shape we render: a non-200 or a malformed body must never
// reach `.length` on an undefined section (the old crash path, P1-24).
function toResults(data: unknown): SearchResults | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const out = { ...EMPTY_SEARCH_RESULTS }
  for (const { key } of SECTIONS) {
    const v = d[key]
    if (v === undefined) continue
    if (!Array.isArray(v)) return null
    out[key] = v as SearchResults[typeof key]
  }
  return out
}

export function GlobalSearch({ triggerClassName = 'text-sidebar-foreground/80', placeholder = 'Search…' }: { triggerClassName?: string; placeholder?: string }) {
  const router = useRouter()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>(EMPTY_SEARCH_RESULTS)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [active, setActive] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (query.trim().length === 0) return
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      setLoading(true)
      setFailed(false)
      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then(async (r) => {
          const parsed = r.ok ? toResults(await r.json().catch(() => null)) : null
          setActive(-1)
          if (!parsed) { setFailed(true); setResults(EMPTY_SEARCH_RESULTS) } else setResults(parsed)
        })
        .catch((err: unknown) => {
          if ((err as { name?: string })?.name === 'AbortError') return
          setFailed(true)
          setResults(EMPTY_SEARCH_RESULTS)
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    }, 200)
    return () => { clearTimeout(timeout); controller.abort() }
  }, [query])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Wave G: Ctrl/Cmd+K anywhere, or "/" outside a text field, focuses search.
  useEffect(() => {
    function handleShortcut(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const inField = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      const isCtrlK = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'
      if (isCtrlK || (e.key === '/' && !inField && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault()
        inputRef.current?.focus()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', handleShortcut)
    return () => document.removeEventListener('keydown', handleShortcut)
  }, [])

  function goTo(href: string) {
    setOpen(false)
    setQuery('')
    setActive(-1)
    router.push(href)
  }

  const hasQuery = query.trim().length > 0
  // Every result in display order: the arrow keys walk this list across sections.
  const flat = SECTIONS.flatMap(({ key }) => results[key].map((item) => ({ key, item })))
  const hasAnyResults = flat.length > 0
  const expanded = open && hasQuery
  const showOptions = expanded && !failed && !loading && hasAnyResults
  const optionId = (i: number) => `${listId}-opt-${i}`

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (expanded) { setOpen(false); setActive(-1) }
      else { setQuery(''); setResults(EMPTY_SEARCH_RESULTS); setFailed(false); setLoading(false) }
      return
    }
    if (!showOptions) {
      if (e.key === 'ArrowDown' && hasQuery) setOpen(true)
      return
    }
    const n = flat.length
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % n) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i <= 0 ? n - 1 : i - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1) }
    else if (e.key === 'Enter') { e.preventDefault(); goTo(flat[active >= 0 && active < n ? active : 0].item.href) }
  }

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${triggerClassName}`} aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showOptions && active >= 0 ? optionId(active) : undefined}
        aria-keyshortcuts="Control+K /"
        value={query}
        onChange={(e) => {
          const v = e.target.value
          setQuery(v)
          setOpen(true)
          setActive(-1)
          if (v.trim().length === 0) { setResults(EMPTY_SEARCH_RESULTS); setLoading(false); setFailed(false) }
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label="Global search"
        className="w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 py-1.5 pl-9 pr-3 text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:border-sidebar-ring focus:outline-none"
      />
      {expanded && (
        <div id={listId} role="listbox" aria-label="Search results" className="absolute left-0 top-full z-50 mt-2 max-h-96 w-96 overflow-y-auto rounded-lg border border-border bg-card p-2 text-left shadow-lg">
          {failed ? (
            <p role="alert" className="p-3 text-sm text-destructive">Search is unavailable right now. Please try again.</p>
          ) : loading ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">Searching…</p>
          ) : !hasAnyResults ? (
            <p role="status" className="p-3 text-sm text-muted-foreground">No results found.</p>
          ) : (
            SECTIONS.map(({ key, label }) => {
              const items = results[key]
              if (items.length === 0) return null
              return (
                <div key={key} role="group" aria-label={label} className="mb-2 last:mb-0">
                  <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground" aria-hidden="true">{label}</p>
                  <ul role="presentation">
                    {items.map((item) => {
                      const index = flat.findIndex((f) => f.key === key && f.item === item)
                      const selected = index === active
                      return (
                      <li key={item.id} role="presentation">
                        <button
                          type="button"
                          id={optionId(index)}
                          role="option"
                          tabIndex={-1}
                          aria-selected={selected}
                          onMouseEnter={() => setActive(index)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => goTo(item.href)}
                          className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-secondary focus:bg-secondary focus:outline-none ${selected ? 'bg-secondary' : ''}`}
                        >
                          <span className="font-medium">{item.label}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{item.detail}</span>
                        </button>
                      </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
