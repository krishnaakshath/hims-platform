'use client'
import { useMemo, useState } from 'react'
import { sendJson } from '@/lib/client-fetch'
import { Button } from '@/components/ui/button'
import { bmiTenths, toVitalsColumns, vitalsFlags, vitalsInputSchema, type VitalsFlag, type VitalsInput } from '@/lib/encounters/vitals'

const FLAG_LABEL: Record<VitalsFlag, string> = {
  bp_high: 'BP high', bp_low: 'BP low', fever: 'Fever', spo2_low: 'SpO2 low', tachycardia: 'Fast pulse', bradycardia: 'Slow pulse',
}

type TempUnit = 'C' | 'F'
interface Fields {
  systolic: string; diastolic: string; pulse: string; temp: string; spo2: string; resp: string
  weight: string; height: string; pain: string; notes: string
}
const EMPTY: Fields = { systolic: '', diastolic: '', pulse: '', temp: '', spo2: '', resp: '', weight: '', height: '', pain: '', notes: '' }

const num = (s: string): number | undefined => {
  const t = s.trim()
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : NaN
}

/** Fahrenheit to Celsius, one decimal (the server stores deci-degrees). */
export function fahrenheitToCelsius(f: number): number {
  return Math.round(((f - 32) * 5) / 9 * 10) / 10
}

function buildInput(f: Fields, unit: TempUnit): VitalsInput {
  const temp = num(f.temp)
  const input: VitalsInput = {
    systolicMmhg: num(f.systolic), diastolicMmhg: num(f.diastolic), pulseBpm: num(f.pulse),
    tempC: temp === undefined || Number.isNaN(temp) ? temp : unit === 'F' ? fahrenheitToCelsius(temp) : temp,
    spo2Pct: num(f.spo2), respRate: num(f.resp), weightKg: num(f.weight), heightCm: num(f.height), painScore: num(f.pain),
    notes: f.notes.trim() === '' ? undefined : f.notes,
  }
  // Drop undefined keys so the strict schema sees only what was typed.
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as VitalsInput
}

export function VitalsForm({ encounterId, onRecorded }: { encounterId: number; onRecorded?: () => void }) {
  const [fields, setFields] = useState<Fields>(EMPTY)
  const [unit, setUnit] = useState<TempUnit>('C')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const input = useMemo(() => buildInput(fields, unit), [fields, unit])
  const parsed = useMemo(() => vitalsInputSchema.safeParse(input), [input])
  const cols = parsed.success ? toVitalsColumns(parsed.data) : null
  const bmi = cols ? bmiTenths(cols.weightG, cols.heightMm) : null
  const flags = cols ? vitalsFlags(cols) : []

  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFields((f) => ({ ...f, [key]: e.target.value }))
    setSaved(false)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the values entered'); return }
    setSubmitting(true)
    setError(null)
    const res = await sendJson(`/api/encounters/${encounterId}/vitals`, 'POST', parsed.data)
    setSubmitting(false)
    if (!res.ok) { setError(res.error); return }
    setFields(EMPTY)
    setSaved(true)
    onRecorded?.()
  }

  const box = 'w-full rounded-md border border-border px-3 py-2 text-sm'
  const field = (label: string, key: keyof Fields, props: { placeholder?: string; step?: string } = {}) => (
    <label className="block text-xs font-medium text-muted-foreground">
      {label}
      <input type="number" inputMode="decimal" step={props.step ?? 'any'} value={fields[key]} onChange={set(key)} placeholder={props.placeholder} className={`${box} mt-1 text-foreground`} />
    </label>
  )

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Record vitals">
      <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <legend className="sr-only">Blood pressure</legend>
        {field('Systolic (mmHg)', 'systolic', { placeholder: '120' })}
        {field('Diastolic (mmHg)', 'diastolic', { placeholder: '80' })}
        {field('Pulse (bpm)', 'pulse')}
        {field('SpO2 (%)', 'spo2')}
      </fieldset>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          {field(`Temperature (°${unit})`, 'temp', { step: '0.1' })}
          <div role="group" aria-label="Degrees unit" className="mt-1 flex gap-1 text-xs">
            {(['C', 'F'] as const).map((u) => (
              <button key={u} type="button" aria-pressed={unit === u} onClick={() => { setUnit(u); setSaved(false) }}
                className={`rounded border px-2 py-0.5 ${unit === u ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground'}`}>°{u}</button>
            ))}
          </div>
        </div>
        {field('Resp rate (/min)', 'resp')}
        {field('Weight (kg)', 'weight', { step: '0.001' })}
        {field('Height (cm)', 'height', { step: '0.1' })}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {field('Pain score (0-10)', 'pain', { step: '1' })}
        <label className="col-span-2 block text-xs font-medium text-muted-foreground sm:col-span-3">
          Notes
          <textarea value={fields.notes} onChange={set('notes')} maxLength={300} rows={1} className={`${box} mt-1 text-foreground`} />
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <span data-testid="bmi" className="text-muted-foreground">BMI: {bmi == null ? 'n/a' : (bmi / 10).toFixed(1)}</span>
        {flags.map((f) => (
          <span key={f} className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">{FLAG_LABEL[f]}</span>
        ))}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={submitting}>Record vitals</Button>
        {saved && <span role="status" className="text-sm text-success">Recorded</span>}
      </div>
    </form>
  )
}
