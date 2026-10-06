import Link from 'next/link'
import { redirect } from 'next/navigation'
import type { ComponentType } from 'react'
import { UserPlus, FileCheck2, ClipboardCheck, Hourglass } from 'lucide-react'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getPipelinePerformance, getPipelineTrend } from '@/lib/queries/pipeline-dashboard'
import { PipelineTrendChart } from '@/components/PipelineTrendChart'

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'

const PRESETS = [
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
  { key: 'last30', label: 'Last 30 Days' },
] as const

const TILE_COLOR: Record<string, string> = {
  primary: 'bg-primary/10 text-primary',
  pink: 'bg-pink-500/10 text-pink-700',
  amber: 'bg-amber-500/10 text-amber-700',
  violet: 'bg-violet-500/10 text-violet-700',
}

function StatTile({ icon: Icon, value, label, color }: { icon: ComponentType<{ className?: string }>; value: string; label: string; color: keyof typeof TILE_COLOR }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4 shadow-none">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${TILE_COLOR[color]}`} aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-xl font-bold tabular-nums text-foreground">{value}</p>
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

function resolveRange(preset: string | undefined, from: string | undefined, to: string | undefined) {
  const now = new Date()
  if (preset === 'custom' && from && to) {
    return { from: new Date(from), to: new Date(to), preset: 'custom' as const }
  }
  if (preset === 'week') {
    const start = new Date(now)
    start.setDate(now.getDate() - now.getDay())
    start.setHours(0, 0, 0, 0)
    return { from: start, to: now, preset: 'week' as const }
  }
  if (preset === 'last30') {
    const start = new Date(now)
    start.setDate(now.getDate() - 30)
    return { from: start, to: now, preset: 'last30' as const }
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1)
  return { from: start, to: now, preset: 'month' as const }
}

export default async function PipelineDashboardPage({ searchParams }: { searchParams: Promise<{ preset?: string; from?: string; to?: string }> }) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:64 — the Pipeline Dashboard entry is rendered for admin/crc
  // only. Same list, same redirect target as workbook/page.tsx:12.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const sp = await searchParams
  const range = resolveRange(sp.preset, sp.from, sp.to)
  const [performance, trend] = await Promise.all([
    getPipelinePerformance({ from: range.from, to: range.to }),
    getPipelineTrend({ from: range.from, to: range.to }),
  ])
  await logAudit(session, 'viewed pipeline performance dashboard', null)

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Pipeline Performance</h1>
        <div className="flex gap-1 rounded-lg bg-secondary p-1 text-sm">
          {PRESETS.map((p) => (
            <Link key={p.key} href={`/pipeline-dashboard?preset=${p.key}`} className={`rounded-md px-3 py-1.5 font-medium transition-colors ${range.preset === p.key ? 'bg-card text-primary shadow-none' : 'text-muted-foreground hover:text-foreground'}`}>{p.label}</Link>
          ))}
        </div>
      </div>

      <form className={`mb-6 flex flex-wrap items-end gap-3 text-sm ${SECTION}`} action="/pipeline-dashboard">
        <input type="hidden" name="preset" value="custom" />
        <div>
          <label htmlFor="pipeline-from" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">From</label>
          <input id="pipeline-from" type="date" name="from" defaultValue={range.from.toISOString().slice(0, 10)} className="rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div>
          <label htmlFor="pipeline-to" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">To</label>
          <input id="pipeline-to" type="date" name="to" defaultValue={range.to.toISOString().slice(0, 10)} className="rounded-md border border-border bg-card px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <button type="submit" className="rounded-md border border-border px-4 py-2 font-medium text-foreground transition-colors hover:bg-secondary">Update</button>
      </form>

      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile icon={UserPlus} value={String(performance.referralsReceived)} label="Referrals received" color="primary" />
        <StatTile icon={FileCheck2} value={String(performance.formsCompleted)} label="Forms completed" color="pink" />
        <StatTile icon={ClipboardCheck} value={String(performance.patientsClassified)} label="Patients classified" color="amber" />
        <StatTile icon={Hourglass} value={performance.avgDaysToClassify !== null ? performance.avgDaysToClassify.toFixed(1) : '—'} label="Avg. days to classify" color="violet" />
      </div>

      <section>
        <h2 className="mb-3 border-l-2 border-primary/50 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity Over Time</h2>
        {trend.length === 0 ? (
          <div className="rounded-md border border-border bg-card p-8 text-center shadow-none">
            <p className="text-sm text-muted-foreground">No pipeline activity in this date range.</p>
          </div>
        ) : (
          <PipelineTrendChart trend={trend} />
        )}
      </section>
    </div>
  )
}
