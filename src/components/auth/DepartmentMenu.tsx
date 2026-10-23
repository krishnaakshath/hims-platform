'use client'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronDown } from 'lucide-react'
import { STAFF_PORTALS } from '@/lib/staff-portals'

// "Department sign-in": one small text button under the staff form that opens
// a listbox of every department sign-in page (/login/<key>). Staff never need
// it -- POST /api/login resolves the role from the credentials -- it is for
// bookmarked/shared department URLs.
//
// The list is not in the DOM until opened. It is an absolutely positioned
// overlay anchored to the button's own left edge: above it when there is
// room (the button sits at the bottom of the form), otherwise flipped below,
// and capped to the space available on that side (scrolls inside). Opening
// or closing it never moves or resizes anything else.
const MENU_MAX = 368
const GAP = 8
const VIEWPORT_MARGIN = 12
export const DEPARTMENTS = STAFF_PORTALS.map((p) => ({ key: p.key, label: p.label, hint: p.description, href: `/login/${p.key}` }))

export function DepartmentMenu({ currentKey }: { currentKey?: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (i: number) => `${baseId}-opt-${i}`
  const currentIndex = DEPARTMENTS.findIndex((d) => d.key === currentKey)
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
    listRef.current?.focus({ preventScroll: true })
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Keep the active option visible by scrolling the list itself, never the page.
  useEffect(() => {
    if (!open) return
    const list = listRef.current
    const el = document.getElementById(optionId(active))
    if (!list || !el) return
    if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active])

  function openMenu() {
    setActive(Math.max(0, currentIndex))
    setOpen(true)
  }

  function close(refocus = true) {
    setOpen(false)
    if (refocus) buttonRef.current?.focus({ preventScroll: true })
  }

  function choose(i: number) {
    close()
    router.push(DEPARTMENTS[i].href)
  }

  function onButtonKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (!open && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      openMenu()
    }
  }

  function onListKeyDown(e: React.KeyboardEvent<HTMLUListElement>) {
    const last = DEPARTMENTS.length - 1
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => Math.min(last, a + 1)); break
      case 'ArrowUp': e.preventDefault(); setActive((a) => Math.max(0, a - 1)); break
      case 'Home': e.preventDefault(); setActive(0); break
      case 'End': e.preventDefault(); setActive(last); break
      case 'Enter': case ' ': e.preventDefault(); choose(active); break
      case 'Escape': e.preventDefault(); close(); break
      case 'Tab': close(false); break
      default:
        if (e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase()
          for (let n = 1; n <= DEPARTMENTS.length; n++) {
            const i = (active + n) % DEPARTMENTS.length
            if (DEPARTMENTS[i].label.toLowerCase().startsWith(k)) { setActive(i); break }
          }
        }
    }
  }

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
        className="inline-flex h-11 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25 aria-expanded:bg-secondary aria-expanded:text-foreground"
      >
        Department sign-in
        <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Department sign-in"
          tabIndex={-1}
          aria-activedescendant={optionId(active)}
          onKeyDown={onListKeyDown}
          data-side={placement.side}
          style={{ maxHeight: placement.maxHeight }}
          className={`auth-pop-menu absolute left-0 z-50 w-[min(21rem,calc(100vw-2.5rem))] overflow-y-auto ${placement.side === 'above' ? 'bottom-full mb-2 origin-bottom-left' : 'top-full mt-2 origin-top-left'} overscroll-contain rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-[0_2px_4px_rgb(0_0_0/0.04),0_24px_48px_-16px_rgb(0_0_0/0.3)] outline-none`}
        >
          {DEPARTMENTS.map((d, i) => (
            <li
              key={d.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === currentIndex}
              data-href={d.href}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              onMouseMove={() => { if (i !== active) setActive(i) }}
              className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 transition-colors ${i === active ? 'bg-secondary' : ''}`}
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium leading-5 text-foreground">{d.label}</span>
                <span className="block truncate text-xs leading-5 text-muted-foreground">{d.hint}</span>
              </span>
              {i === currentIndex ? <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
