// WS4 T12 (spec 3.5 item 25): open and notified critical alerts, each with its call log and the
// action this viewer may take (log the call while open / acknowledge once the call is logged). Hook-free so a Server Component can pass
// `canAcknowledge` (a function); the actions themselves are client components.
import { Siren } from 'lucide-react'
import { formatIstTime } from '@/lib/india-time'
import type { CriticalAlertRow } from '@/lib/queries/lab-critical'
import { CriticalAcknowledgeButton, CriticalNotifyForm } from '@/components/labs/CriticalAlertActions'

const CHANNEL_TEXT = { phone: 'phone', in_person: 'in person', in_app: 'in the app' } as const

/** "Notified Dr Rao at 10:42 am by Meenakshi Sundar (phone, read back)". */
export function criticalCallLine(a: Pick<CriticalAlertRow, 'notifiedAt' | 'notifiedToName' | 'notifiedByName' | 'notifyChannel' | 'readBack'>): string | null {
  if (!a.notifiedAt || !a.notifiedToName) return null
  const how = [a.notifyChannel ? CHANNEL_TEXT[a.notifyChannel] : null, a.readBack ? 'read back' : null].filter(Boolean).join(', ')
  return `Notified ${a.notifiedToName} at ${formatIstTime(a.notifiedAt)} by ${a.notifiedByName ?? 'the lab'}${how ? ` (${how})` : ''}`
}

const patientText = (a: CriticalAlertRow) => (a.uhid ? `${a.patientName} (${a.uhid})` : a.patientName)

export function CriticalResultBanner({ alerts, canNotify, canAcknowledge }: {
  alerts: CriticalAlertRow[]
  canNotify: boolean
  canAcknowledge: (a: CriticalAlertRow) => boolean
}) {
  if (alerts.length === 0) return null
  return (
    <section role="alert" aria-label="Critical results" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
        <Siren className="h-4 w-4" aria-hidden="true" />
        {alerts.length === 1 ? '1 critical result not yet acknowledged' : `${alerts.length} critical results not yet acknowledged`}
      </h2>
      <ul className="space-y-2">
        {alerts.map((a) => {
          const line = criticalCallLine(a)
          return (
            <li key={a.orderId} className="flex flex-wrap items-start justify-between gap-2 rounded border border-destructive/20 bg-background px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-foreground">CRITICAL · {a.summary} · {patientText(a)}</p>
                <p className="text-xs text-muted-foreground">
                  {a.testName} · raised {formatIstTime(a.raisedAt)} · {line ?? 'Call not yet logged'}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                {canNotify && a.status === 'open' && <CriticalNotifyForm orderId={a.orderId} testName={a.testName} />}
                {a.status === 'notified' && canAcknowledge(a) && <CriticalAcknowledgeButton orderId={a.orderId} testName={a.testName} />}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
