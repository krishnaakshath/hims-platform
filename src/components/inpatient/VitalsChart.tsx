'use client'
// WS3 T7: the nursing station's vitals chart -- one small line chart per measure (BP, pulse,
// temperature, SpO2) over the readings passed in (the last 72 h), times in IST.
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatIstDateTime, formatIstDayMonth, formatIstTime, type InstantInput } from '@/lib/india-time'

export interface ChartReading {
  id: number
  recordedAt: InstantInput
  systolicMmhg: number | null
  diastolicMmhg: number | null
  pulseBpm: number | null
  tempDeciC: number | null
  spo2Pct: number | null
}

interface Series { key: string; label: string; color: string }

interface Panel {
  title: string
  unit: string
  series: Series[]
  domain: [number | 'auto', number | 'auto']
  reference?: { y: number; label: string }
}

const PANELS: Panel[] = [
  { title: 'Blood pressure', unit: 'mmHg', series: [{ key: 'systolic', label: 'Systolic', color: 'var(--chart-1)' }, { key: 'diastolic', label: 'Diastolic', color: 'var(--chart-2)' }], domain: [40, 'auto'], reference: { y: 90, label: 'SBP 90' } },
  { title: 'Pulse', unit: 'bpm', series: [{ key: 'pulse', label: 'Pulse', color: 'var(--chart-3)' }], domain: [40, 'auto'], reference: { y: 100, label: '100' } },
  { title: 'Temperature', unit: '°C', series: [{ key: 'temp', label: 'Temperature', color: 'var(--chart-4)' }], domain: [34, 41], reference: { y: 38, label: '38.0' } },
  { title: 'SpO₂', unit: '%', series: [{ key: 'spo2', label: 'SpO₂', color: 'var(--chart-5)' }], domain: [80, 100], reference: { y: 94, label: '94' } },
]

export function VitalsChart({ readings }: { readings: ChartReading[] }) {
  if (readings.length === 0) return <p className="text-sm text-muted-foreground">No vitals recorded in the last 72 hours.</p>

  const data = readings.map((r) => ({
    t: new Date(r.recordedAt as string | Date).getTime(),
    systolic: r.systolicMmhg,
    diastolic: r.diastolicMmhg,
    pulse: r.pulseBpm,
    temp: r.tempDeciC == null ? null : r.tempDeciC / 10,
    spo2: r.spo2Pct,
  }))

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {PANELS.map((p) => (
        <figure key={p.title} className="rounded-lg border border-border bg-card p-3">
          <figcaption className="mb-1 text-sm font-medium text-foreground">{p.title} <span className="font-normal text-muted-foreground">({p.unit})</span></figcaption>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']}
                  tickFormatter={(t: number) => `${formatIstDayMonth(t)} ${formatIstTime(t)}`}
                  tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }}
                />
                <YAxis domain={p.domain} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} width={36} />
                <Tooltip
                  labelFormatter={(t: number) => formatIstDateTime(t, { label: true })}
                  contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)', fontSize: 12 }}
                />
                {p.series.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
                {p.reference && <ReferenceLine y={p.reference.y} stroke="var(--destructive)" strokeDasharray="4 4" />}
                {p.series.map((s) => (
                  <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={{ r: 3 }} connectNulls isAnimationActive={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </figure>
      ))}
    </div>
  )
}
