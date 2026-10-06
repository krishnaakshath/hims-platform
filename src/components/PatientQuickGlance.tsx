import { Stethoscope, Calendar, FileCheck2, ShieldAlert } from 'lucide-react'

const TILE_COLOR: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  sky: 'bg-sky-500/10 text-sky-700',
  accent: 'bg-accent/10 text-accent',
  amber: 'bg-amber-500/10 text-amber-700',
}

function Tile({ icon: Icon, label, value, color }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; color: keyof typeof TILE_COLOR }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-3">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${TILE_COLOR[color]}`} aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

export function PatientQuickGlance({ provider, chartDataAsOf, identityVerified, criteriaCount }: {
  provider: string | null
  chartDataAsOf: string
  identityVerified: boolean
  criteriaCount: number
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Tile icon={Stethoscope} label="Provider" value={provider ?? 'Unassigned'} color="primary" />
      <Tile icon={Calendar} label="Chart as of" value={new Date(chartDataAsOf).toLocaleDateString()} color="sky" />
      <Tile icon={FileCheck2} label="Criteria evaluated" value={String(criteriaCount)} color="accent" />
      <Tile icon={ShieldAlert} label="Identity" value={identityVerified ? 'Verified' : 'Pending'} color="amber" />
    </div>
  )
}
