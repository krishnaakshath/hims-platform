'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { PatientAvatar } from '@/components/PatientAvatar'
import { AppointmentStatusChip } from '@/components/AppointmentStatusChip'
import { StartTelemedicineButton } from '@/components/StartTelemedicineButton'
import type { AppointmentStatus } from '@/lib/queries/appointments'

export interface DashboardAppointmentRow {
  id: number
  patientId: string
  patientName: string
  providerName: string
  visitReason: string
  status: AppointmentStatus
  startsAt: string
}

// Same deterministic-hash approach as PatientAvatar's color assignment --
// a stable, repeatable color per visit reason without inventing per-visit
// payment/category data the app doesn't actually track.
const REASON_PILL_CLASSES = [
  'bg-sky-500/10 text-sky-700',
  'bg-primary/10 text-primary',
  'bg-amber-500/10 text-amber-700',
  'bg-chart-4/10 text-chart-4',
  'bg-accent/10 text-accent',
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function ReasonPill({ reason }: { reason: string }) {
  const className = REASON_PILL_CLASSES[hashString(reason) % REASON_PILL_CLASSES.length]
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{reason}</span>
}

const STATUS_OPTIONS: { value: AppointmentStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All Statuses' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'no_show', label: 'No-Show' },
]

const SELECT_CLASS = 'rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:border-primary/40 focus:outline-none'

export function DashboardAppointmentsTable({ appointments, canStartTelemedicine = false }: { appointments: DashboardAppointmentRow[]; canStartTelemedicine?: boolean }) {
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus | 'all'>('all')

  const filtered = useMemo(() => {
    if (statusFilter === 'all') return appointments
    return appointments.filter((a) => a.status === statusFilter)
  }, [appointments, statusFilter])

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Appointments</h2>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AppointmentStatus | 'all')}
            aria-label="Filter by status"
            className={SELECT_CLASS}
          >
            {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No appointments match this filter.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Visit Reason</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2 pr-3 font-semibold">Date</th>
                <th className="py-2 pr-3 font-semibold">Time</th>
                <th className="py-2 pr-3 font-semibold">Provider</th>
                {canStartTelemedicine && <th className="py-2 pr-3 font-semibold">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const startsAt = new Date(a.startsAt)
                return (
                  <tr key={a.id} className="border-b border-border last:border-b-0 hover:bg-secondary/50">
                    <td className="py-2.5 pr-3">
                      <Link href={`/patients/${a.patientId}`} className="flex items-center gap-2.5 font-medium text-foreground hover:text-primary">
                        <PatientAvatar name={a.patientName} size="sm" />
                        {a.patientName}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3"><ReasonPill reason={a.visitReason} /></td>
                    <td className="py-2.5 pr-3"><AppointmentStatusChip status={a.status} /></td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{startsAt.toLocaleDateString([], { dateStyle: 'medium' })}</td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{startsAt.toLocaleTimeString([], { timeStyle: 'short' })}</td>
                    <td className="py-2.5 pr-3 text-muted-foreground">{a.providerName}</td>
                    {canStartTelemedicine && (
                      <td className="py-2.5 pr-3">
                        {a.status === 'scheduled' && <StartTelemedicineButton appointmentId={a.id} />}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
