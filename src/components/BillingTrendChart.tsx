'use client'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'

export function BillingTrendChart({ trend }: { trend: { month: string; grossChargesCents: number; netCollectionsCents: number }[] }) {
  const data = trend.map((t) => ({
    month: t.month,
    'Gross Charges': Math.round(t.grossChargesCents / 100),
    'Net Collections': Math.round(t.netCollectionsCents / 100),
  }))

  return (
    <div className="h-72 w-full rounded-lg border border-border bg-card p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="month" tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
          <YAxis tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
          <Tooltip
            formatter={(value: number) => `$${value.toLocaleString()}`}
            contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', fontSize: 12 }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="Gross Charges" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="Net Collections" stroke="var(--chart-2)" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
