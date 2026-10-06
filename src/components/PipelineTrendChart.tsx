'use client'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

export interface PipelineTrendDatum { date: string; referrals: number; formsCompleted: number; classified: number }

export function PipelineTrendChart({ trend }: { trend: PipelineTrendDatum[] }) {
  const data = trend.map((t) => ({
    date: t.date,
    Referrals: t.referrals,
    'Forms Completed': t.formsCompleted,
    Classified: t.classified,
  }))

  return (
    <div className="h-72 w-full rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
          <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} allowDecimals={false} />
          <Tooltip contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', fontSize: 12 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Referrals" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Forms Completed" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="Classified" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
