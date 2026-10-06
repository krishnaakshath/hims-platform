'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AppointmentStatus } from '@/lib/queries/appointments'

const STATUS_OPTIONS: AppointmentStatus[] = ['scheduled', 'completed', 'cancelled', 'no_show']

const STATUS_STYLE: Record<AppointmentStatus, string> = {
  scheduled: 'border-primary/30 bg-primary/5 text-primary',
  completed: 'border-success/30 bg-success/5 text-success',
  cancelled: 'border-border bg-secondary text-muted-foreground',
  no_show: 'border-destructive/30 bg-destructive/5 text-destructive',
}

export function AppointmentStatusSelect({ appointmentId, status }: { appointmentId: number; status: AppointmentStatus }) {
  const router = useRouter()
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function updateStatus(next: string) {
    setUpdating(true)
    setError(null)
    try {
      const res = await fetch(`/api/appointments/${appointmentId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      })
      if (res.ok) {
        router.refresh()
        return
      }
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not update this appointment.')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div>
      <select
        value={status}
        disabled={updating}
        onChange={(e) => updateStatus(e.target.value)}
        className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize disabled:opacity-50 ${STATUS_STYLE[status]}`}
      >
        {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s.replace('_', '-')}</option>)}
      </select>
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}
