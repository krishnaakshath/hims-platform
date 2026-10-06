'use client'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export function ArAgingChart({ buckets }: { buckets: { label: string; outstandingCents: number }[] }) {
  const data = buckets.map((b) => ({ label: b.label, outstanding: Math.round(b.outstandingCents / 100) }))

  return (
    <div className="h-72 w-full rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="label" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
          <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(value: number) => [`$${value.toLocaleString()}`, 'Outstanding']}
            contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', fontSize: 12 }}
          />
          <Bar dataKey="outstanding" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
