'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import type { SearchResults } from '@/lib/queries/search'

const EMPTY_RESULTS: SearchResults = { patients: [], trials: [], formTemplates: [] }
const SECTIONS: { key: keyof SearchResults; label: string }[] = [
  { key: 'patients', label: 'Patients' },
  { key: 'trials', label: 'Trials & Protocols' },
  { key: 'formTemplates', label: 'Form Templates' },
]

export function GlobalSearch({ triggerClassName = 'text-sidebar-foreground/80' }: { triggerClassName?: string }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (query.trim().length === 0) {
      setResults(EMPTY_RESULTS)
      setLoading(false)
      return
    }
    setLoading(true)
    const timeout = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => r.json())
        .then((data: SearchResults) => setResults(data))
        .finally(() => setLoading(false))
    }, 200)
    return () => clearTimeout(timeout)
  }, [query])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  function goTo(href: string) {
    setOpen(false)
    setQuery('')
    router.push(href)
  }

  const hasAnyResults = results.patients.length > 0 || results.trials.length > 0 || results.formTemplates.length > 0

  return (
    <div ref={containerRef} className="relative w-full max-w-sm">
      <Search className={`pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ${triggerClassName}`} aria-hidden="true" />
      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        placeholder="Search patients, trials, forms…"
        aria-label="Global search"
        className="w-full rounded-md border border-sidebar-border bg-sidebar-accent/40 py-1.5 pl-9 pr-3 text-sm text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:border-sidebar-ring focus:outline-none"
      />
      {open && query.trim().length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-2 max-h-96 w-96 overflow-y-auto rounded-lg border border-border bg-card p-2 text-left shadow-lg">
          {loading ? (
            <p className="p-3 text-sm text-muted-foreground">Searching…</p>
          ) : !hasAnyResults ? (
            <p className="p-3 text-sm text-muted-foreground">No results found.</p>
          ) : (
            SECTIONS.map(({ key, label }) => {
              const items = results[key]
              if (items.length === 0) return null
              return (
                <div key={key} className="mb-2 last:mb-0">
                  <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
                  <ul>
                    {items.map((item) => (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => goTo(item.href)}
                          className="flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-secondary"
                        >
                          <span className="font-medium">{item.label}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{item.detail}</span>
                        </button>
                      </li>
                    ))}
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
