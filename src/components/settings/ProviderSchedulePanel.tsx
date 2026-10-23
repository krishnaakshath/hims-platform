'use client'
// WS6 T6 (spec D5): an admin edits a doctor's weekly working hours (Monday to Saturday, several
// sessions a day), slot length and leave days. Saving replaces the whole template and every leave
// day from today on (earlier leave is kept as history on the server).
import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { todayIsoIn } from '@/lib/india-time'
import type { WeeklySession } from '@/lib/scheduling/slots'

interface ScheduleResponse {
  slotMinutes: number
  opdRoom: string | null
  sessions: WeeklySession[]
  leave: { date: string; reason: string }[]
}

interface SessionDraft { key: number; weekday: WeeklySession['weekday']; start: string; end: string }
interface LeaveDraft { key: number; date: string; reason: string }

const DAYS: { weekday: WeeklySession['weekday']; label: string }[] = [
  { weekday: 1, label: 'Monday' },
  { weekday: 2, label: 'Tuesday' },
  { weekday: 3, label: 'Wednesday' },
  { weekday: 4, label: 'Thursday' },
  { weekday: 5, label: 'Friday' },
  { weekday: 6, label: 'Saturday' },
]
const SLOT_LENGTHS = Array.from({ length: 12 }, (_, i) => (i + 1) * 5)
const INPUT = 'rounded-md border border-border px-2 py-1 text-sm'

let nextKey = 1
const key = () => nextKey++

/** Problems shown under the form; saving is blocked while there are any. */
function problemsOf(sessions: SessionDraft[], leave: LeaveDraft[]): string[] {
  const out: string[] = []
  for (const d of DAYS) {
    const day = sessions.filter((s) => s.weekday === d.weekday)
    if (day.some((s) => !s.start || !s.end || s.end <= s.start)) { out.push(`${d.label}: each session must end after it starts.`); continue }
    const sorted = [...day].sort((a, b) => a.start.localeCompare(b.start))
    if (sorted.some((s, i) => i > 0 && s.start < sorted[i - 1].end)) out.push(`${d.label}: sessions must not overlap.`)
  }
  if (leave.some((l) => !l.date || l.reason.trim() === '')) out.push('Each leave day needs a date and a reason.')
  const dates = leave.map((l) => l.date).filter(Boolean)
  if (new Set(dates).size !== dates.length) out.push('Each leave date can be listed once.')
  return out
}

export function ProviderSchedulePanel({ provider, onClose }: { provider: { id: number; name: string }; onClose: () => void }) {
  const toast = useToast()
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [slotMinutes, setSlotMinutes] = useState('15')
  const [sessions, setSessions] = useState<SessionDraft[]>([])
  const [leave, setLeave] = useState<LeaveDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchJson<ScheduleResponse>(`/api/providers/${provider.id}/schedule`).then((res) => {
      if (cancelled) return
      if (!res.ok) { setLoadError(res.error); return }
      setSlotMinutes(String(res.data.slotMinutes))
      setSessions(res.data.sessions.map((s) => ({ key: key(), ...s })))
      setLeave(res.data.leave.map((l) => ({ key: key(), ...l })))
      setLoaded(true)
    })
    return () => { cancelled = true }
  }, [provider.id])

  const updateSession = (k: number, patch: Partial<SessionDraft>) => setSessions((ss) => ss.map((s) => (s.key === k ? { ...s, ...patch } : s)))
  const updateLeave = (k: number, patch: Partial<LeaveDraft>) => setLeave((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)))
  const problems = problemsOf(sessions, leave)

  async function save() {
    setSaving(true)
    setError(null)
    const res = await sendJson(`/api/providers/${provider.id}/schedule`, 'PUT', {
      slotMinutes: Number(slotMinutes),
      // Sunday sessions are not edited here; any already on file are sent back unchanged.
      sessions: [...sessions]
        .sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start))
        .map(({ weekday, start, end }) => ({ weekday, start, end })),
      leave: [...leave].sort((a, b) => a.date.localeCompare(b.date)).map(({ date, reason }) => ({ date, reason: reason.trim() })),
    })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    toast.show({ title: `Working hours saved for ${provider.name}` })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Working hours: {provider.name}</DialogTitle>
        </DialogHeader>
        {loadError ? (
          <p role="alert" className="text-sm text-destructive">{loadError}</p>
        ) : !loaded ? (
          <p className="text-sm text-muted-foreground">Loading working hours…</p>
        ) : (
          <div className="max-h-[70vh] space-y-4 overflow-y-auto">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Slot length (minutes)</span>
              <select value={slotMinutes} onChange={(e) => setSlotMinutes(e.target.value)} aria-label="Slot length (minutes)" className={INPUT}>
                {SLOT_LENGTHS.map((m) => <option key={m} value={String(m)}>{m}</option>)}
              </select>
            </label>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Weekly sessions (IST)</p>
              {DAYS.map((d) => {
                const day = sessions.filter((s) => s.weekday === d.weekday)
                return (
                  <fieldset key={d.weekday} aria-label={d.label} className="flex flex-wrap items-center gap-2 border-b border-border pb-2 last:border-b-0">
                    <legend className="sr-only">{d.label}</legend>
                    <span aria-hidden="true" className="w-24 text-sm font-medium text-foreground">{d.label}</span>
                    {day.length === 0 && <span className="text-xs text-muted-foreground">Not working</span>}
                    {day.map((s, i) => {
                      const n = i + 1
                      return (
                        <span key={s.key} className="flex items-center gap-1">
                          <input type="time" value={s.start} onChange={(e) => updateSession(s.key, { start: e.target.value })} aria-label={`Start, ${d.label} session ${n}`} className={INPUT} />
                          <span className="text-xs text-muted-foreground">to</span>
                          <input type="time" value={s.end} onChange={(e) => updateSession(s.key, { end: e.target.value })} aria-label={`End, ${d.label} session ${n}`} className={INPUT} />
                          <Button size="sm" variant="outline" onClick={() => setSessions((ss) => ss.filter((x) => x.key !== s.key))} aria-label={`Remove ${d.label} session ${n}`}>Remove</Button>
                        </span>
                      )
                    })}
                    <Button size="sm" variant="outline" disabled={sessions.length >= 21} onClick={() => setSessions((ss) => [...ss, { key: key(), weekday: d.weekday, start: '09:00', end: '13:00' }])} aria-label={`Add session, ${d.label}`}>
                      Add session
                    </Button>
                  </fieldset>
                )
              })}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Leave days</p>
              {leave.length === 0 && <p className="text-xs text-muted-foreground">No leave from today on.</p>}
              {leave.map((l, i) => {
                const n = i + 1
                return (
                  <div key={l.key} className="flex flex-wrap items-center gap-2">
                    <input type="date" min={todayIsoIn()} value={l.date} onChange={(e) => updateLeave(l.key, { date: e.target.value })} aria-label={`Leave date, row ${n}`} className={INPUT} />
                    <input value={l.reason} maxLength={120} onChange={(e) => updateLeave(l.key, { reason: e.target.value })} aria-label={`Leave reason, row ${n}`} placeholder="Reason" className={`${INPUT} min-w-48 flex-1`} />
                    <Button size="sm" variant="outline" onClick={() => setLeave((ls) => ls.filter((x) => x.key !== l.key))} aria-label={`Remove leave row ${n}`}>Remove</Button>
                  </div>
                )
              })}
              <Button size="sm" variant="outline" disabled={leave.length >= 60} onClick={() => setLeave((ls) => [...ls, { key: key(), date: '', reason: '' }])}>Add leave day</Button>
            </div>

            {problems.length > 0 && (
              <ul className="space-y-0.5 text-xs text-destructive">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!loaded || saving || problems.length > 0}>Save working hours</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
