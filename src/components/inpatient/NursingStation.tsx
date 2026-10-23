'use client'
// WS3 T7: the nursing station -- today's medication round (grouped by IST hour, overdue after
// 30 minutes, charted through the existing administer route, pi/admin only) and the vitals tab
// (record a reading, last 72 h chart, warning chips). Patients are shown by name, UHID and bed.
import { useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { formatIstDateTime, formatIstLongDate, formatIstTime, istLocalToOffsetString, type InstantInput } from '@/lib/india-time'
import type { VitalWarning } from '@/lib/inpatient/vitals'
import { VitalsChart, type ChartReading } from './VitalsChart'

type DoseStatus = 'scheduled' | 'given' | 'held' | 'refused'

export interface RoundRowView {
  medicationId: number
  admissionId: number
  patientName: string
  uhid: string | null
  bedLabel: string | null
  medicationName: string
  dose: string
  scheduledFor: InstantInput
  status: DoseStatus
  overdue: boolean
}

export interface AdmittedPatientView {
  admissionId: number
  patientName: string
  uhid: string | null
  bedLabel: string | null
  ward: string | null
}

interface ReadingView extends ChartReading {
  respRate: number | null
  painScore: number | null
  weightG: number | null
  notes: string | null
  recordedByName: string
  warnings: VitalWarning[]
}

const VITAL_WARNING_LABELS: Record<VitalWarning, string> = {
  fever: 'Fever',
  hypothermia: 'Hypothermia',
  tachycardia: 'Tachycardia',
  bradycardia: 'Bradycardia',
  hypotension: 'Hypotension',
  hypertension: 'Hypertension',
  hypoxia: 'Low SpO₂',
  tachypnoea: 'Tachypnoea',
}

const STATUS_LABEL: Record<DoseStatus, string> = { scheduled: 'Scheduled', given: 'Given', held: 'Held', refused: 'Refused' }

const IST_MS = 330 * 60_000
const HOUR_MS = 3600_000
/** The instant the IST hour containing `t` starts. */
function istHourStart(t: InstantInput): number {
  const ms = new Date(t as string | Date).getTime()
  return Math.floor((ms + IST_MS) / HOUR_MS) * HOUR_MS - IST_MS
}

function groupByHour(rows: RoundRowView[]): { hour: number; rows: RoundRowView[] }[] {
  const groups = new Map<number, RoundRowView[]>()
  for (const r of rows) {
    const h = istHourStart(r.scheduledFor)
    groups.set(h, [...(groups.get(h) ?? []), r])
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([hour, list]) => ({ hour, rows: list }))
}

function patientLine(p: { patientName: string; uhid: string | null; bedLabel: string | null }) {
  return `${p.patientName}${p.uhid ? ` · UHID ${p.uhid}` : ''}${p.bedLabel ? ` · ${p.bedLabel}` : ''}`
}

export function NursingStation({ date, initialWard, initialRound, admitted, canChartDoses }: {
  date: string
  initialWard: string | null
  initialRound: RoundRowView[]
  admitted: AdmittedPatientView[]
  canChartDoses: boolean
}) {
  return (
    <Tabs defaultValue="round">
      <TabsList>
        <TabsTrigger value="round">Medication round</TabsTrigger>
        <TabsTrigger value="vitals">Vitals</TabsTrigger>
      </TabsList>
      <TabsContent value="round" className="pt-3">
        <MedicationRound date={date} initialWard={initialWard} initialRows={initialRound} admitted={admitted} canChartDoses={canChartDoses} />
      </TabsContent>
      <TabsContent value="vitals" className="pt-3">
        <VitalsPanel admitted={admitted} />
      </TabsContent>
    </Tabs>
  )
}

function MedicationRound({ date, initialWard, initialRows, admitted, canChartDoses }: {
  date: string; initialWard: string | null; initialRows: RoundRowView[]; admitted: AdmittedPatientView[]; canChartDoses: boolean
}) {
  const [ward, setWard] = useState(initialWard ?? '')
  const [rows, setRows] = useState(initialRows)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [pending, setPending] = useState<{ row: RoundRowView; status: 'held' | 'refused'; reason: string } | null>(null)
  const wards = [...new Set(admitted.map((a) => a.ward).filter((w): w is string => w !== null))].sort()

  async function reload(nextWard: string) {
    const qs = new URLSearchParams({ date, ...(nextWard ? { ward: nextWard } : {}) })
    const res = await fetchJson<{ rows: RoundRowView[] }>(`/api/inpatient/medication-round?${qs}`)
    if (!res.ok) { setError(res.error); return }
    setError(null)
    setRows(res.data.rows)
  }

  async function chart(row: RoundRowView, status: 'given' | 'held' | 'refused', notes?: string) {
    setBusyId(row.medicationId)
    setError(null)
    const res = await sendJson(`/api/inpatient/admissions/${row.admissionId}/medications/${row.medicationId}/administer`, 'POST', { status, ...(notes ? { notes } : {}) })
    setBusyId(null)
    if (!res.ok) { setError(res.error); return }
    setPending(null)
    await reload(ward)
  }

  const groups = groupByHour(rows)
  return (
    <section aria-label="Medication round">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">{formatIstLongDate(`${date}T12:00:00+05:30`)}</p>
        <label className="flex items-center gap-2 text-sm">
          Ward
          <select
            value={ward}
            onChange={(e) => { setWard(e.target.value); void reload(e.target.value) }}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="">All wards</option>
            {wards.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="mb-2 text-sm text-destructive">{error}</p>}
      {groups.length === 0 && <p className="text-sm text-muted-foreground">No doses scheduled today for admitted patients.</p>}
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.hour}>
            <h3 className="mb-1 text-sm font-semibold text-foreground">{formatIstTime(g.hour, { label: true })}</h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {g.rows.map((r) => (
                <li key={r.medicationId} className={`px-3 py-2 text-sm ${r.overdue ? 'bg-destructive/5' : ''}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium text-foreground">
                        <span>{r.medicationName}</span> <span className="font-normal text-muted-foreground">({r.dose})</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{patientLine(r)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">{formatIstTime(r.scheduledFor)}</span>
                      {r.overdue
                        ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">Overdue</span>
                        : <span className="text-xs font-medium text-muted-foreground">{STATUS_LABEL[r.status]}</span>}
                      {canChartDoses && r.status === 'scheduled' && (
                        <>
                          <Button size="xs" onClick={() => chart(r, 'given')} disabled={busyId === r.medicationId} aria-label={`Give ${r.medicationName} to ${r.patientName}`}>Give</Button>
                          <Button size="xs" variant="outline" onClick={() => setPending({ row: r, status: 'held', reason: '' })} disabled={busyId === r.medicationId} aria-label={`Hold ${r.medicationName} for ${r.patientName}`}>Hold</Button>
                          <Button size="xs" variant="destructive" onClick={() => setPending({ row: r, status: 'refused', reason: '' })} disabled={busyId === r.medicationId} aria-label={`Refuse ${r.medicationName} for ${r.patientName}`}>Refuse</Button>
                        </>
                      )}
                    </div>
                  </div>
                  {pending?.row.medicationId === r.medicationId && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        value={pending.reason}
                        onChange={(e) => setPending({ ...pending, reason: e.target.value })}
                        placeholder={`Reason for ${pending.status === 'held' ? 'holding' : 'refusing'} this dose (required)`}
                        aria-label="Reason"
                        className="flex-1 rounded-md border border-border px-3 py-1.5 text-sm"
                      />
                      <Button size="xs" variant="outline" onClick={() => setPending(null)}>Cancel</Button>
                      <Button size="xs" onClick={() => chart(pending.row, pending.status, pending.reason.trim())} disabled={!pending.reason.trim() || busyId === r.medicationId}>Confirm</Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  )
}

const EMPTY_FORM = { systolic: '', diastolic: '', pulse: '', temp: '', spo2: '', resp: '', pain: '', weight: '', notes: '', takenAt: '' }
type FormState = typeof EMPTY_FORM

const NUMERIC_FIELDS: { key: Exclude<keyof FormState, 'notes' | 'takenAt'>; label: string; body: string; step?: string }[] = [
  { key: 'systolic', label: 'Systolic (mmHg)', body: 'systolicMmhg' },
  { key: 'diastolic', label: 'Diastolic (mmHg)', body: 'diastolicMmhg' },
  { key: 'pulse', label: 'Pulse (bpm)', body: 'pulseBpm' },
  { key: 'temp', label: 'Temperature (°C)', body: 'tempC', step: '0.1' },
  { key: 'spo2', label: 'SpO₂ (%)', body: 'spo2Pct' },
  { key: 'resp', label: 'Resp. rate (/min)', body: 'respRate' },
  { key: 'pain', label: 'Pain (0-10)', body: 'painScore' },
  { key: 'weight', label: 'Weight (kg)', body: 'weightKg', step: '0.001' },
]

function WarningChips({ warnings }: { warnings: VitalWarning[] }) {
  if (warnings.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {warnings.map((w) => <span key={w} className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{VITAL_WARNING_LABELS[w]}</span>)}
    </span>
  )
}

function VitalsPanel({ admitted }: { admitted: AdmittedPatientView[] }) {
  const [admissionId, setAdmissionId] = useState<number | null>(null)
  const [readings, setReadings] = useState<ReadingView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  async function load(id: number) {
    const res = await fetchJson<{ readings: ReadingView[] }>(`/api/inpatient/admissions/${id}/vitals`)
    if (!res.ok) { setLoadError(res.error); setReadings(null); return }
    setLoadError(null)
    setReadings(res.data.readings)
  }

  function select(value: string) {
    const id = value ? Number(value) : null
    setAdmissionId(id)
    setReadings(null)
    setForm(EMPTY_FORM)
    setSaveError(null)
    if (id !== null) void load(id)
  }

  async function save() {
    if (admissionId === null) return
    const body: Record<string, unknown> = {}
    for (const f of NUMERIC_FIELDS) {
      const raw = form[f.key].trim()
      if (raw !== '') body[f.body] = Number(raw)
    }
    if (form.notes.trim()) body.notes = form.notes.trim()
    if (form.takenAt) {
      const at = istLocalToOffsetString(form.takenAt)
      if (!at) { setSaveError('Enter a valid time.'); return }
      body.recordedAt = at
    }
    setSaving(true)
    setSaveError(null)
    const res = await sendJson(`/api/inpatient/admissions/${admissionId}/vitals`, 'POST', body)
    setSaving(false)
    if (!res.ok) { setSaveError(res.error); return }
    setForm(EMPTY_FORM)
    await load(admissionId)
  }

  const latest = readings && readings.length > 0 ? readings[readings.length - 1] : null
  const hasMeasure = NUMERIC_FIELDS.some((f) => form[f.key].trim() !== '')

  return (
    <section aria-label="Vitals" className="space-y-4">
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Patient
        <select
          value={admissionId ?? ''}
          onChange={(e) => select(e.target.value)}
          className="min-w-[16rem] rounded-md border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">Select an admitted patient</option>
          {admitted.map((a) => <option key={a.admissionId} value={a.admissionId}>{patientLine(a)}</option>)}
        </select>
      </label>
      {admitted.length === 0 && <p className="text-sm text-muted-foreground">No patients are admitted.</p>}

      {admissionId !== null && (
        <>
          <div className="rounded-lg border border-border bg-card p-3">
            <h3 className="mb-2 text-sm font-semibold text-foreground">Record vitals</h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {NUMERIC_FIELDS.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {f.label}
                  <input
                    type="number" inputMode="decimal" step={f.step ?? '1'} value={form[f.key]}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                  />
                </label>
              ))}
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Time taken (IST; blank = now)
                <input
                  type="datetime-local" value={form.takenAt}
                  onChange={(e) => setForm({ ...form, takenAt: e.target.value })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                />
              </label>
              <label className="col-span-2 flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-3">
                Notes
                <input
                  value={form.notes} maxLength={300}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                />
              </label>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={saving || !hasMeasure}>Save vitals</Button>
              {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
            </div>
          </div>

          {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
          {readings === null && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}
          {latest && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              Latest {formatIstDateTime(latest.recordedAt, { label: true })} by {latest.recordedByName}
              <WarningChips warnings={latest.warnings} />
            </p>
          )}
          {readings !== null && <VitalsChart readings={readings} />}
          {readings !== null && readings.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border text-sm">
              {[...readings].reverse().map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <span className="text-muted-foreground">{formatIstDateTime(r.recordedAt)}</span>
                  {r.systolicMmhg != null && <span>BP {r.systolicMmhg}/{r.diastolicMmhg ?? '–'}</span>}
                  {r.pulseBpm != null && <span>Pulse {r.pulseBpm}</span>}
                  {r.tempDeciC != null && <span>{(r.tempDeciC / 10).toFixed(1)} °C</span>}
                  {r.spo2Pct != null && <span>SpO₂ {r.spo2Pct}%</span>}
                  {r.respRate != null && <span>RR {r.respRate}</span>}
                  {r.painScore != null && <span>Pain {r.painScore}/10</span>}
                  {r.weightG != null && <span>{(r.weightG / 1000).toFixed(1)} kg</span>}
                  <WarningChips warnings={r.warnings} />
                  {r.notes && <span className="text-muted-foreground">{r.notes}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
