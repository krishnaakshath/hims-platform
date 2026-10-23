'use client'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronDown, Search } from 'lucide-react'
import { STAFF_PORTALS } from '@/lib/staff-portals'
import type { Design } from '@/components/auth/auth-styles'

// "Department sign-in": one small text button under the staff form that opens
// a listbox of every department sign-in page (/login/<key>). Staff never need
// it -- POST /api/login resolves the role from the credentials -- it is for
// bookmarked/shared department URLs. In the typographic design it is a
// command-palette: a filter field above the list.
//
// The list is not in the DOM until opened. It is an absolutely positioned
// overlay anchored to the button's own left edge: above it when there is
// room, otherwise flipped below, capped to the space on that side (scrolls
// inside). Opening or closing it never moves or resizes anything else.
const MENU_MAX = 368
const GAP = 8
const VIEWPORT_MARGIN = 12
export const DEPARTMENTS = STAFF_PORTALS.map((p) => ({ key: p.key, label: p.label, hint: p.description, href: `/login/${p.key}` }))

const LOOK: Record<Design, { trigger: string; panel: string; option: string; active: string; label: string; hint: string; check: string }> = {
  a: {
    trigger: 'text-white/80 hover:bg-white/10 hover:text-white focus-visible:ring-white/40 aria-expanded:bg-white/10 aria-expanded:text-white',
    panel: 'rounded-2xl border border-white/15 bg-[color-mix(in_oklch,var(--auth-panel-deep)_88%,transparent)] text-white shadow-[0_24px_60px_-18px_rgb(0_0_0/0.6)] backdrop-blur-xl',
    option: 'rounded-xl',
    active: 'bg-white/12',
    label: 'text-white',
    hint: 'text-white/65',
    check: 'text-[var(--auth-line)]',
  },
  b: {
    trigger: 'font-mono text-[12px] uppercase tracking-[0.14em] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-primary/25 aria-expanded:bg-secondary aria-expanded:text-foreground',
    panel: 'rounded-md border border-foreground/15 bg-popover text-popover-foreground shadow-[0_2px_0_var(--border),0_20px_40px_-16px_rgb(0_0_0/0.3)]',
    option: 'rounded-sm',
    active: 'bg-secondary',
    label: 'font-mono text-[13px] uppercase tracking-[0.08em] text-foreground',
    hint: 'text-muted-foreground',
    check: 'text-primary',
  },
  c: {
    trigger: 'text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-primary/25 aria-expanded:bg-secondary aria-expanded:text-foreground',
    panel: 'rounded-2xl border border-border bg-popover text-popover-foreground shadow-[0_2px_4px_rgb(0_0_0/0.04),0_28px_56px_-20px_rgb(0_0_0/0.35)]',
    option: 'rounded-lg',
    active: 'bg-secondary',
    label: 'text-foreground',
    hint: 'text-muted-foreground',
    check: 'text-primary',
  },
}

export function DepartmentMenu({ currentKey, design = 'a' }: { currentKey?: string; design?: Design }) {
  const router = useRouter()
  const look = LOOK[design]
  const palette = design === 'c'
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (key: string) => `${baseId}-opt-${key}`
  const items = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? DEPARTMENTS.filter((d) => d.label.toLowerCase().includes(q) || d.hint.toLowerCase().includes(q)) : DEPARTMENTS
  }, [query])
  const [placement, setPlacement] = useState<{ side: 'above' | 'below'; maxHeight: number }>({ side: 'above', maxHeight: MENU_MAX })

  // Measure before paint so the list appears in its final place.
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return
    const r = buttonRef.current.getBoundingClientRect()
    const above = r.top - GAP - VIEWPORT_MARGIN
    const below = window.innerHeight - r.bottom - GAP - VIEWPORT_MARGIN
    const side = above >= Math.min(MENU_MAX, 240) || above >= below ? 'above' : 'below'
    setPlacement({ side, maxHeight: Math.max(160, Math.min(MENU_MAX, side === 'above' ? above : below)) })
  }, [open])

  useEffect(() => {
    if (!open) return
    ;(palette ? inputRef.current : listRef.current)?.focus({ preventScroll: true })
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open, palette])

  // Palette design: "/" opens it from anywhere that is not a text field.
  useEffect(() => {
    if (!palette) return
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      setQuery('')
      setActive(0)
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [palette])

  // Keep the active option visible by scrolling the list itself, never the page.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const key = items[active]?.key
    const el = key ? document.getElementById(optionId(key)) : null
    if (!list || !el) return
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active, items])

  function openMenu() {
    setQuery('')
    setActive(Math.max(0, DEPARTMENTS.findIndex((d) => d.key === currentKey)))
    setOpen(true)
  }

  function close(refocus = true) {
    setOpen(false)
    if (refocus) buttonRef.current?.focus({ preventScroll: true })
  }

  function choose(i: number) {
    const item = items[i]
    if (!item) return
    close()
    router.push(item.href)
  }

  function onButtonKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      openMenu()
    }
  }

  function onListKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    const last = items.length - 1
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => Math.min(last, a + 1)); break
      case 'ArrowUp': e.preventDefault(); setActive((a) => Math.max(0, a - 1)); break
      case 'Home': if (!palette) { e.preventDefault(); setActive(0) } break
      case 'End': if (!palette) { e.preventDefault(); setActive(last) } break
      case 'Enter': e.preventDefault(); choose(active); break
      case ' ': if (!palette) { e.preventDefault(); choose(active) } break
      case 'Escape': e.preventDefault(); close(); break
      case 'Tab': close(false); break
      default:
        if (!palette && e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase()
          for (let n = 1; n <= items.length; n++) {
            const i = (active + n) % items.length
            if (items[i].label.toLowerCase().startsWith(k)) { setActive(i); break }
          }
        }
    }
  }

  const activeId = items[active] ? optionId(items[active].key) : undefined

  return (
    <div ref={rootRef} className="relative -ml-3 inline-block">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onButtonKeyDown}
        className={`inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-[3px] ${look.trigger}`}
      >
        Department sign-in
        {palette ? (
          <kbd aria-hidden="true" className="hidden rounded border border-border px-1.5 font-mono text-[11px] leading-5 text-muted-foreground sm:inline">/</kbd>
        ) : (
          <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        )}
      </button>
      {open && (
        <div
          data-side={placement.side}
          className={`auth-pop-menu absolute left-0 z-50 flex w-[min(22rem,calc(100vw-2.5rem))] flex-col overflow-hidden ${placement.side === 'above' ? 'bottom-full mb-2 origin-bottom-left' : 'top-full mt-2 origin-top-left'} ${look.panel}`}
          style={{ maxHeight: placement.maxHeight }}
        >
          {palette ? (
            <div className="flex items-center gap-2 border-b border-border px-3.5">
              <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                role="combobox"
                aria-label="Find a department"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0) }}
                onKeyDown={onListKeyDown}
                placeholder="Find a department"
                className="h-12 w-full bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          ) : null}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Department sign-in"
            tabIndex={palette ? undefined : -1}
            aria-activedescendant={palette ? undefined : activeId}
            onKeyDown={palette ? undefined : onListKeyDown}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5 outline-none"
          >
            {items.map((d, i) => (
              <li
                key={d.key}
                id={optionId(d.key)}
                role="option"
                aria-selected={d.key === currentKey}
                data-href={d.href}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
                onMouseMove={() => { if (i !== active) setActive(i) }}
                className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 py-2 transition-colors ${look.option} ${i === active ? look.active : ''}`}
              >
                <span className="min-w-0">
                  <span className={`block text-sm font-medium leading-5 ${look.label}`}>{d.label}</span>
                  <span className={`block truncate text-xs leading-5 ${look.hint}`}>{d.hint}</span>
                </span>
                {d.key === currentKey ? <Check aria-hidden="true" className={`h-4 w-4 shrink-0 ${look.check}`} /> : null}
              </li>
            ))}
            {items.length === 0 ? <li role="presentation" className="px-3 py-3 text-sm text-muted-foreground">No department matches.</li> : null}
          </ul>
        </div>
      )}
    </div>
  )
}
