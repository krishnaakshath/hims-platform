'use client'
// Code search for the coding workspace: a combobox over GET /api/coding/codes (the kind's current
// code-system version), debounced 250 ms, with a keyboard-operable listbox (ArrowUp/ArrowDown,
// Enter to pick, Escape to close). A superseded search is aborted. Sample (fictional) code sets
// are labelled "Sample"; category headers that cannot be coded are shown but cannot be picked.
import { useEffect, useId, useState } from 'react'
import { CODE_SYSTEM_LABEL, type CodeSystemKind } from '@/lib/coding/code-systems'
import { searchCodeSet, type CodeSearchHit, type CodeSearchResult } from './codingApi'

export const CODE_SEARCH_DEBOUNCE_MS = 250

export function SampleBadge() {
  return (
    <span className="inline-flex items-center rounded border border-amber-400 bg-amber-50 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
      Sample
    </span>
  )
}

export function CodePicker({ kinds, onDate, onPick, label = 'Search codes' }: {
  kinds: readonly CodeSystemKind[]
  onDate: string
  onPick: (hit: CodeSearchHit) => void
  label?: string
}) {
  const id = useId()
  const listId = `${id}-list`
  const [kind, setKind] = useState<CodeSystemKind>(kinds[0])
  const [q, setQ] = useState('')
  const [result, setResult] = useState<CodeSearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [loading, setLoading] = useState(false)
  const term = q.trim()

  useEffect(() => {
    if (!term) return
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const r = await searchCodeSet(kind, term, onDate, ctrl.signal)
        if (ctrl.signal.aborted) return
        if (r.ok) {
          setResult(r.data)
          setError(null)
          setOpen(true)
          setActive(-1)
        } else {
          setResult(null)
          setError(r.error)
          setOpen(false)
        }
        setLoading(false)
      } catch {
        // Aborted by a newer search; that search owns the state.
      }
    }, CODE_SEARCH_DEBOUNCE_MS)
    return () => { clearTimeout(timer); ctrl.abort() }
  }, [term, kind, onDate])

  const hits = result?.hits ?? []
  const pick = (h: CodeSearchHit | undefined) => {
    if (!h || !h.selectable) return
    onPick(h)
    setQ('')
    setResult(null)
    setOpen(false)
    setActive(-1)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open && result) setOpen(true)
      setActive((a) => Math.min(a + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && active >= 0) { e.preventDefault(); pick(hits[active]) }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setActive(-1) }
    }
  }

  const kindLabel = CODE_SYSTEM_LABEL[kind]
  const optionId = (h: CodeSearchHit) => `${id}-opt-${h.id}`
  const activeHit = open && active >= 0 ? hits[active] : undefined

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        {kinds.length > 1 ? (
          <label className="flex flex-col gap-1 text-xs font-medium">
            Code set
            <select
              value={kind}
              onChange={(e) => { setKind(e.target.value as CodeSystemKind); setResult(null); setOpen(false) }}
              className="h-8 rounded-lg border border-input bg-background px-2 text-sm"
            >
              {kinds.map((k) => <option key={k} value={k}>{CODE_SYSTEM_LABEL[k]}</option>)}
            </select>
          </label>
        ) : (
          <span className="pb-1.5 text-xs font-medium text-muted-foreground">{kindLabel}</span>
        )}
        <div className="relative min-w-56 flex-1">
          <input
            type="text"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeHit ? optionId(activeHit) : undefined}
            autoComplete="off"
            maxLength={60}
            placeholder={`Code or words (${kindLabel})`}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              if (!e.target.value.trim()) { setResult(null); setOpen(false); setError(null) }
            }}
            onKeyDown={onKeyDown}
            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          {open && result && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-popover shadow-md">
              {result.codeSystem === null ? (
                <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{`No ${kindLabel} code set loaded`}</p>
              ) : (
                <>
                  {result.codeSystem.isSample && (
                    <p className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                      <SampleBadge /> Fictional sample codes, for testing only
                    </p>
                  )}
                  {hits.length === 0 ? (
                    <p role="status" className="px-3 py-2 text-sm text-muted-foreground">No matching codes</p>
                  ) : (
                    <ul id={listId} role="listbox" aria-label={`${kindLabel} codes`} className="max-h-64 overflow-y-auto py-1">
                      {hits.map((h, i) => (
                        <li
                          key={h.id}
                          id={optionId(h)}
                          role="option"
                          aria-selected={i === active}
                          aria-disabled={!h.selectable || undefined}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(h)}
                          className={`flex cursor-pointer items-start gap-2 px-3 py-1.5 text-sm ${i === active ? 'bg-muted' : ''} ${h.selectable ? '' : 'cursor-not-allowed opacity-60'}`}
                        >
                          <span className="font-mono text-xs font-semibold">{h.code}</span>
                          <span className="flex-1">{h.display}</span>
                          {h.isSample && <SampleBadge />}
                          {!h.selectable && <span className="text-xs text-muted-foreground">(category, cannot be coded)</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        {loading && <span className="pb-1.5 text-xs text-muted-foreground" aria-live="polite">Searching…</span>}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
