// WS8 T15: the "Needs attention" strip above a role's dashboard tiles. Each item is a link to the
// page that lists what it counts (loadNeedsAttention only returns items the role may open). With
// nothing to show it renders nothing at all, not an empty box.
import Link from 'next/link'
import { AlertTriangle, ArrowRight, XCircle } from 'lucide-react'
import type { AttentionItem } from '@/lib/queries/needs-attention'

const TONE: Record<AttentionItem['tone'], string> = {
  danger: 'border-destructive/30 bg-destructive/5 text-destructive',
  warning: 'border-warning/30 bg-warning/5 text-warning',
}

export function NeedsAttentionStrip({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null
  return (
    <section aria-label="Needs attention" className="mb-4">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Needs attention</h2>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const Icon = item.tone === 'danger' ? XCircle : AlertTriangle
          return (
            <li key={item.id}>
              <Link href={item.href} data-attention={item.id} className={`flex items-center gap-3 rounded-md border px-3 py-2.5 transition-colors hover:bg-muted/40 ${TONE[item.tone]}`}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="text-lg font-bold tabular-nums">{item.count}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{item.label}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
