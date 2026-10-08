'use client'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { formatIstDateTime } from '@/lib/india-time'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import type { NotificationSeverity, StaffFeed } from '@/lib/notifications/staff-feed'

// Wave G P2-01: the bell is the signed-in user's live notification feed (GET
// /api/notifications) for every staff role -- no simulated items, and no longer the
// admin audit log. Unread state is stored per user on the server; opening an item or
// "Mark all as read" records it. The count refreshes every minute while the tab is visible.
const POLL_MS = 60_000
const EMPTY: StaffFeed = { items: [], unreadCount: 0 }

const SEVERITY_DOT: Record<NotificationSeverity, string> = {
  info: 'bg-primary',
  warning: 'bg-amber-500',
  critical: 'bg-destructive',
}
const SEVERITY_TEXT: Record<NotificationSeverity, string> = { info: '', warning: 'Needs attention: ', critical: 'Urgent: ' }

function isFeed(data: unknown): data is StaffFeed {
  return !!data && typeof data === 'object' && Array.isArray((data as StaffFeed).items) && typeof (data as StaffFeed).unreadCount === 'number'
}

export function NotificationPanel({ triggerClassName = 'text-muted-foreground hover:bg-secondary' }: { triggerClassName?: string }) {
  const panelId = useId()
  const headingId = useId()
  const [open, setOpen] = useState(false)
  const [feed, setFeed] = useState<StaffFeed>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const bellRef = useRef<HTMLButtonElement>(null)

  const applyLoad = useCallback((res: Awaited<ReturnType<typeof fetchJson<StaffFeed>>>) => {
    if (res.ok && isFeed(res.data)) { setFeed(res.data); setLoadError(null) }
    else setLoadError(res.ok ? 'Something went wrong on our side. Please try again.' : res.error)
    setLoaded(true)
  }, [])

  const load = useCallback(async () => {
    applyLoad(await fetchJson<StaffFeed>('/api/notifications', { cache: 'no-store' }))
  }, [applyLoad])

  // First load, then every POLL_MS while the tab is visible.
  useEffect(() => {
    let disposed = false
    async function refresh() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const res = await fetchJson<StaffFeed>('/api/notifications', { cache: 'no-store' })
      if (!disposed) applyLoad(res)
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { disposed = true; clearInterval(timer) }
  }, [applyLoad])

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  function toggle() {
    const next = !open
    setOpen(next)
    setActionError(null)
    if (next) void load()
  }

  function close() {
    setOpen(false)
    bellRef.current?.focus()
  }

  async function markRead(body: { keys: string[] } | { all: true }) {
    const res = await sendJson<StaffFeed>('/api/notifications/read', 'POST', body)
    if (res.ok && isFeed(res.data)) { setFeed(res.data); setActionError(null) }
    else setActionError(res.ok ? 'Something went wrong on our side. Please try again.' : res.error)
  }

  const unread = feed.unreadCount
  const bellLabel = unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={bellRef}
        type="button"
        onClick={toggle}
        className={`relative rounded-md p-2 transition-colors ${triggerClassName}`}
        aria-label={bellLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        <Bell className="h-4.5 w-4.5" aria-hidden="true" />
        {unread > 0 && (
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] font-semibold leading-4 text-destructive-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }}
          className="absolute right-0 top-full z-50 mt-2 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <p id={headingId} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={() => void markRead({ all: true })} className="rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-secondary">
                Mark all as read
              </button>
            )}
          </div>
          {actionError && <p role="alert" className="mb-2 text-sm text-destructive">{actionError}</p>}
          {loadError && feed.items.length === 0 ? (
            <p role="alert" className="text-sm text-destructive">{loadError}</p>
          ) : !loaded ? (
            <p role="status" className="text-sm text-muted-foreground">Loading…</p>
          ) : feed.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">You&apos;re all caught up. Nothing new for you.</p>
          ) : (
            <ul className="max-h-96 space-y-1 overflow-y-auto">
              {feed.items.map((n) => (
                <li key={n.key}>
                  <Link
                    href={n.href}
                    onClick={() => { if (!n.read) void markRead({ keys: [n.key] }); setOpen(false) }}
                    className={`flex gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-secondary focus:bg-secondary focus:outline-none ${n.read ? 'opacity-70' : ''}`}
                  >
                    <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : SEVERITY_DOT[n.severity]}`} />
                    <span className="min-w-0 flex-1">
                      <span className={`block ${n.read ? 'text-foreground' : 'font-semibold text-foreground'}`}>
                        <span className="sr-only">{n.read ? '' : 'Unread. '}{SEVERITY_TEXT[n.severity]}</span>
                        {n.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{n.detail}</span>
                      <span className="block text-xs text-muted-foreground">{formatIstDateTime(n.occurredAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
