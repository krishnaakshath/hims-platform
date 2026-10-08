// Wave E: one KPI tile for every role dashboard. A tile always links to the
// page that lists what it counts (`href` is required): a number a user cannot
// drill into is a dead end. Callers pass only hrefs the viewing role can open
// (tests/pages/dashboard-links.test.tsx renders each dashboard and checks every
// link against that role's page gates).
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { PortalTileLink } from '@/components/PortalTileLink'

export type KpiTone = 'primary' | 'success' | 'warning' | 'danger' | 'muted'

const TONE: Record<KpiTone, string> = {
  primary: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted text-muted-foreground',
}

export interface KpiTileProps {
  label: string
  value: string | number
  href: string
  sub?: string
  icon: React.ComponentType<{ className?: string }>
  tone?: KpiTone
}

export function KpiTile({ label, value, href, sub, icon: Icon, tone = 'primary' }: KpiTileProps) {
  return (
    <PortalTileLink href={href} spotlightColor="rgba(61, 79, 143, 0.1)" className="flex items-center gap-3 rounded-md border border-border bg-card p-4 transition-colors duration-200 hover:bg-muted/40">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TONE[tone]}`} aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <p className="text-2xl font-bold tabular-nums text-foreground" data-kpi-value>{value}</p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground" data-kpi-label>{label}</p>
        {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
    </PortalTileLink>
  )
}

export function KpiGrid({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">{children}</div>
}

export function DashSection({ title, href, linkLabel = 'Open', children }: { title: string; href?: string; linkLabel?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        {href && (
          <Link href={href} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            {linkLabel}<ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
      {children}
    </section>
  )
}

/** Bed occupancy by ward: one bar per ward (occupied of usable beds). */
export function WardOccupancy({ wards }: { wards: { ward: string; beds: number; occupied: number; available: number; dirty: number; blocked: number; occupancyPct: number | null }[] }) {
  if (wards.length === 0) return <p className="py-4 text-center text-sm text-muted-foreground">No beds configured.</p>
  return (
    <ul className="space-y-2.5">
      {wards.map((w) => (
        <li key={w.ward}>
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="truncate font-medium text-foreground">{w.ward}</span>
            <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
              {w.occupied}/{w.beds - w.blocked} occupied · {w.available} free{w.dirty > 0 ? ` · ${w.dirty} to clean` : ''}{w.blocked > 0 ? ` · ${w.blocked} blocked` : ''}
            </span>
          </div>
          <div className="mt-1 flex h-1.5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${w.ward}: ${w.occupancyPct ?? 0}% occupied`}>
            <div className="h-full bg-primary" style={{ width: `${w.occupancyPct ?? 0}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** "45 min" / "2 h 5 min"; em dash when there is no figure. */
export function formatMinutes(min: number | null): string {
  if (min === null) return '—'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** "72%" or an em dash. */
export function formatPct(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`
}
