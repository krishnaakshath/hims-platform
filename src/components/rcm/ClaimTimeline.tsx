import { formatPaise } from '@/lib/format'
import { formatDateTimeIn, formatIsoDate } from '@/lib/india-time'
import type { ClaimWorkspace } from '@/lib/queries/claim-workspace'
import { Panel } from './ui'

export function ClaimTimeline({ events }: { events: ClaimWorkspace['events'] }) {
  return (
    <Panel title="Timeline">
      {events.length === 0 ? <p className="text-sm text-muted-foreground">Nothing recorded yet.</p> : (
        <ol className="space-y-2 text-sm">
          {events.map((e) => (
            <li key={e.id} className="border-l-2 border-border pl-3">
              <p className="font-medium">{e.action.replace(/_/g, ' ')} <span className="text-xs text-muted-foreground">{e.fromStatus ?? '—'} → {e.toStatus}</span></p>
              <p className="text-xs text-muted-foreground">{formatDateTimeIn(e.at)} · {e.byName}{e.amountPaise !== null ? ` · ${formatPaise(e.amountPaise)}` : ''}{e.portalCheckedOn ? ` · portal checked ${formatIsoDate(e.portalCheckedOn)}` : ''}</p>
              {e.note && <p className="text-xs">{e.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
