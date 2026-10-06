'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Filter } from 'lucide-react'
import type { AppointmentStatus } from '@/lib/queries/appointments'

export interface ScheduleRow {
  id: number
  patientId: string
  patientName: string
  startsAt: Date
  visitReason: string
  status: AppointmentStatus
}

const STATUS_LABEL: Record<AppointmentStatus, string> = {
  scheduled: 'Scheduled',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No Show',
}

/**
 * Today's Schedule timeline on the doctor dashboard, with its own status
 * filter -- pulled out of the page into a client component because the
 * filter needs state, while the rest of the dashboard stays a server
 * component.
 */
export function DoctorScheduleTimeline({ appointments }: { appointments: ScheduleRow[] }) {
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | 'all'>('all')
  const [open, setOpen] = useState(false)

  const filtered = useMemo(
    () => (statusFilter === 'all' ? appointments : appointments.filter((a) => a.status === statusFilter)),
    [appointments, statusFilter]
  )

  return (
    <div className="relative">
      <div className="flex items-center justify-end gap-2 px-0 pb-3">
        <div className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Filter className="h-3 w-3" /> {statusFilter === 'all' ? 'Filter' : STATUS_LABEL[statusFilter]}
          </button>
          {open && (
            <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-md border border-border bg-card py-1 shadow-md">
              <button
                onClick={() => { setStatusFilter('all'); setOpen(false) }}
                className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
              >
                All
              </button>
              {(Object.keys(STATUS_LABEL) as AppointmentStatus[]).map((s) => (
                <button
                  key={s}
                  onClick={() => { setStatusFilter(s); setOpen(false) }}
                  className="block w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted"
                >
                  {STATUS_LABEL[s]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-8 text-center text-sm text-muted-foreground">
          {appointments.length === 0 ? 'No appointments scheduled for today.' : `No ${STATUS_LABEL[statusFilter as AppointmentStatus]?.toLowerCase() ?? ''} appointments today.`}
        </div>
      ) : (
        <div className="divide-y divide-border">
          {filtered.map((a) => (
            <div key={a.id} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/10">
              <div className="flex w-24 flex-col items-end border-r border-border pr-4">
                <span className="text-sm font-bold text-foreground">
                  {new Date(a.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{a.status}</span>
              </div>
              <div className="flex flex-1 flex-col">
                <div className="flex items-center justify-between">
                  <Link href={`/patients/${a.patientId}`} className="text-sm font-bold text-primary hover:underline">
                    {a.patientName} <span className="text-xs font-normal text-muted-foreground">({a.patientId})</span>
                  </Link>
                  {a.status === 'scheduled' && (
                    <Link href={`/patients/${a.patientId}`} className="rounded bg-success/10 px-2.5 py-1 text-xs font-bold text-success hover:bg-success/20">
                      Start Encounter
                    </Link>
                  )}
                </div>
                <p className="mt-1 text-xs text-foreground/80">{a.visitReason}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
