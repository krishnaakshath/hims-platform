'use client'
import { formatIstTime } from '@/lib/india-time'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Filter } from 'lucide-react'
import type { AppointmentStatus } from '@/lib/queries/appointments'
import type { EncounterStatus } from '@/lib/encounters/status'
import { StartEncounterButton } from '@/components/encounters/StartEncounterButton'

export interface ScheduleRow {
  id: number
  patientId: string
  patientName: string
  startsAt: Date
  visitReason: string
  status: AppointmentStatus
  // WS1 T3: the visit checked in from this appointment (null until the front desk checks it in).
  encounterId: number | null
  encounterStatus: EncounterStatus | null
  uhid: string | null
}

// WS1 T3 (spec ruling 2): the doctor never checks a patient in. A checked-in visit is started
// explicitly (POST, then the workspace opens); one in consultation is continued; an appointment
// with no visit yet waits for the front desk.
function VisitAction({ row }: { row: ScheduleRow }) {
  if (row.encounterId !== null && row.encounterStatus === 'checked_in') return <StartEncounterButton encounterId={row.encounterId} />
  if (row.encounterId !== null && row.encounterStatus === 'in_consultation') {
    return <Link href={`/encounters/${row.encounterId}`} className="rounded bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary hover:bg-primary/20">Continue</Link>
  }
  if (row.encounterId !== null && row.encounterStatus === 'completed') {
    return <Link href={`/encounters/${row.encounterId}`} className="text-xs font-medium text-primary hover:underline">View visit</Link>
  }
  if (row.encounterId === null && row.status === 'scheduled') {
    return <span className="rounded bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">Awaiting check-in</span>
  }
  return null
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
                  {formatIstTime(a.startsAt)}
                </span>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{a.status}</span>
              </div>
              <div className="flex flex-1 flex-col">
                <div className="flex items-center justify-between">
                  <Link href={`/patients/${a.patientId}`} className="text-sm font-bold text-primary hover:underline">
                    {a.patientName}{a.uhid && <span className="text-xs font-normal text-muted-foreground"> ({a.uhid})</span>}
                  </Link>
                  <VisitAction row={a} />
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
