import { formatPaise } from '@/lib/format'
import { formatDateTimeIn } from '@/lib/india-time'
import { PREAUTH_STATUS_LABEL, type PreauthStatus } from '@/lib/rcm/preauth-status'
import type { PreauthDetail } from '@/lib/queries/preauths'
import { Panel } from './ui'

export function PreauthTimeline({ events }: { events: PreauthDetail['events'] }) {
  return (
    <Panel title="Timeline">
      {events.length === 0 ? <p className="text-sm text-muted-foreground">Still a draft.</p> : (
        <ol className="space-y-2 text-sm">
          {events.map((e) => (
            <li key={e.id} className="border-l-2 border-border pl-3">
              <p className="font-medium">{e.action.replace(/_/g, ' ')} → {PREAUTH_STATUS_LABEL[e.toStatus as PreauthStatus]}</p>
              <p className="text-xs text-muted-foreground">{formatDateTimeIn(e.at)} · {e.byName}{e.amountPaise !== null ? ` · ${formatPaise(e.amountPaise)}` : ''}{e.reasonCode ? ` · ${e.reasonCode}` : ''}{e.hasSnapshot ? ' · request snapshot kept' : ''}</p>
              {e.note && <p className="text-xs">{e.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
