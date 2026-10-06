'use client'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'

export interface ScreeningBreakdown {
  green: number
  yellow: number
  red: number
}

const SEGMENTS: { key: keyof ScreeningBreakdown; label: string; color: string; dotClassName: string }[] = [
  { key: 'green', label: 'Meets', color: 'var(--success)', dotClassName: 'bg-success' },
  { key: 'yellow', label: 'Needs Verification', color: 'var(--warning)', dotClassName: 'bg-warning' },
  { key: 'red', label: 'Potential Exclusion', color: 'var(--destructive)', dotClassName: 'bg-destructive' },
]

// Donut + legend adaptation of the reference dashboard's "Working hours"
// gauge card -- same shape (arc + breakdown list of colored dot / number /
// label), sourced from real screening verdict counts instead.
export function ScreeningBreakdownChart({ breakdown }: { breakdown: ScreeningBreakdown }) {
  const total = breakdown.green + breakdown.yellow + breakdown.red
  const data = SEGMENTS.map((s) => ({ name: s.label, value: breakdown[s.key], color: s.color }))

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-40 w-40 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={48} outerRadius={68} paddingAngle={total > 0 ? 3 : 0} startAngle={90} endAngle={-270}>
              {data.map((d) => <Cell key={d.name} fill={d.color} stroke="none" />)}
            </Pie>
            <Tooltip
              formatter={(value: number, name: string) => [`${value}`, name]}
              contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', fontSize: 12, borderRadius: 8 }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold tabular-nums text-foreground">{total}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Screened</span>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-2.5">
        {SEGMENTS.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.dotClassName}`} aria-hidden="true" />
            <span className="font-semibold tabular-nums text-foreground">{breakdown[s.key]}</span>
            <span className="truncate text-muted-foreground">{s.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
