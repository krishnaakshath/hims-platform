'use client'
import { useState } from 'react'
import type { BookingRequestRow } from '@/lib/queries/booking-requests'
import { Button } from '@/components/ui/button'
import { ConfirmBookingRequestModal } from '@/components/ConfirmBookingRequestModal'
import { DeclineBookingRequestModal } from '@/components/DeclineBookingRequestModal'

interface ProviderOption {
  id: number
  name: string
}

type BookingRequestStatus = BookingRequestRow['status']

// Status is always a colored dot + plain text label, never color alone --
// same convention as StatusChip.tsx/AssignmentStatusChip.tsx.
const STATUS_CONFIG: Record<BookingRequestStatus, { label: string; dotClassName: string; textClassName: string }> = {
  pending: { label: 'Pending', dotClassName: 'bg-warning', textClassName: 'text-warning' },
  confirmed: { label: 'Confirmed', dotClassName: 'bg-success', textClassName: 'text-success' },
  declined: { label: 'Declined', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
}

function BookingRequestStatusChip({ status }: { status: BookingRequestStatus }) {
  const { label, dotClassName, textClassName } = STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}

function formatDate(value: string | Date) {
  const d = typeof value === 'string' ? new Date(`${value}T00:00:00`) : value
  return d.toLocaleDateString([], { dateStyle: 'medium' })
}

export function BookingRequestsQueue({ requests, providers, canResolve }: {
  requests: BookingRequestRow[]
  providers: ProviderOption[]
  canResolve: boolean
}) {
  const [confirmTarget, setConfirmTarget] = useState<BookingRequestRow | null>(null)
  const [declineTarget, setDeclineTarget] = useState<BookingRequestRow | null>(null)

  const providerName = (id: number | null) => {
    if (id === null) return 'No preference'
    return providers.find((p) => p.id === id)?.name ?? `Provider #${id}`
  }

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-secondary/40 text-left">
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Requester</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preferred Provider</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preferred Dates</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reason</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
              <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Submitted</th>
              {canResolve && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {requests.length === 0 && (
              <tr>
                <td colSpan={canResolve ? 7 : 6} className="p-6 text-center text-muted-foreground">No booking requests yet.</td>
              </tr>
            )}
            {requests.map((r, i) => (
              <tr key={r.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                <td className="p-3 text-foreground">
                  <div className="font-medium">{r.requesterName}</div>
                  <div className="text-xs text-muted-foreground">DOB {formatDate(r.requesterDob)}</div>
                </td>
                <td className="p-3 text-foreground">{providerName(r.preferredProviderId)}</td>
                <td className="p-3 text-foreground">{formatDate(r.preferredDateRangeStart)} – {formatDate(r.preferredDateRangeEnd)}</td>
                <td className="p-3 text-foreground">{r.reason}</td>
                <td className="p-3">
                  <BookingRequestStatusChip status={r.status} />
                  {r.status === 'declined' && r.declineReason && (
                    <div className="mt-1 text-xs text-muted-foreground">{r.declineReason}</div>
                  )}
                  {r.status === 'confirmed' && r.resultingAppointmentId && (
                    <div className="mt-1 text-xs text-muted-foreground">Appointment #{r.resultingAppointmentId}</div>
                  )}
                </td>
                <td className="p-3 text-muted-foreground">{formatDate(r.submittedAt)}</td>
                {canResolve && (
                  <td className="p-3">
                    {r.status === 'pending' ? (
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => setConfirmTarget(r)}>Confirm</Button>
                        <Button size="sm" variant="outline" onClick={() => setDeclineTarget(r)}>Decline</Button>
                      </div>
                    ) : null}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmTarget && (
        <ConfirmBookingRequestModal request={confirmTarget} providers={providers} onClose={() => setConfirmTarget(null)} />
      )}
      {declineTarget && (
        <DeclineBookingRequestModal request={declineTarget} onClose={() => setDeclineTarget(null)} />
      )}
    </>
  )
}
