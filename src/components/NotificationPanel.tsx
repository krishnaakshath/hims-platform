'use client'
import { useState, useEffect } from 'react'
import { Bell } from 'lucide-react'
import type { Role } from '@/lib/auth'

interface Event { id: number; action: string; timestamp: string }

export function NotificationPanel({ role, triggerClassName = 'text-muted-foreground hover:bg-secondary' }: { role: Role; triggerClassName?: string }) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<Event[]>([])

  useEffect(() => {
    if (open) {
      fetch('/api/audit-log?limit=10')
        .then((r) => r.json())
        .then((data) => setEvents((data.entries ?? []).slice(0, 10)))
    }
  }, [open])

  // GET /api/audit-log is admin-only (see src/app/api/audit-log/route.ts) --
  // a CRC/PI session would always get a 403 here, silently rendered as an
  // empty "No records found" list. Hide the affordance entirely for roles
  // that can never use it, rather than shipping a permanently dead bell.
  if (role !== 'admin') return null

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className={`relative rounded-md p-2 transition-colors ${triggerClassName}`} aria-label="Notifications">
        <Bell className="h-4.5 w-4.5" aria-hidden="true" />
        {events.length > 0 && <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent" aria-hidden="true" />}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-lg border border-border bg-card p-3 shadow-lg">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent Activity</p>
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records found.</p>
          ) : (
            <ul className="space-y-2">
              {events.map((e) => (
                <li key={e.id} className="text-sm">
                  <span className="text-foreground">{e.action}</span>
                  <span className="ml-1 text-xs text-muted-foreground">{new Date(e.timestamp).toLocaleTimeString()}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
