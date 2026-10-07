'use client'
// SP5: the collector's "My route" screen. Mobile-first: one column of stop cards with large tap
// targets. Per stop: the window, the patient (first name + initial, UHID, age/gender), a tel:
// link, the visit address and landmark, and per test the container and the expected sample ID.
// "Mark collected" asks for the sample ID of each tube drawn (empty = not collected) and checks
// the check digit before posting; "Could not collect" cancels with a doorstep reason only.
// Dates are formatted by a pure helper (no toLocale* / Intl), so SSR and the browser agree.
import { useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { RouteStop } from '@/lib/queries/home-collections'
import { COLLECTOR_CANCEL_REASONS, type HomeCollectionStatus } from '@/lib/home-collection/rules'
import { displaySampleId, parseSampleId } from '@/lib/labs/sample-id'
import { SAMPLE_CONTAINER_LABEL } from '@/lib/labs/catalog'
import { GENDERS } from '@/lib/india/reference'
import { addDaysIso } from '@/lib/follow-ups/rules'
import { collectVisit } from '@/components/home-collection/api'
import { CancelVisitDialog } from '@/components/home-collection/CancelVisitDialog'
import { FIELD } from '@/components/home-collection/WindowSelect'

const STATUS_LABEL: Record<HomeCollectionStatus, string> = { booked: 'To collect', collected: 'Collected', cancelled: 'Cancelled' }
const STATUS_CLASS: Record<HomeCollectionStatus, string> = {
  booked: 'bg-primary/10 text-primary',
  collected: 'bg-success/10 text-success',
  cancelled: 'bg-muted text-muted-foreground',
}
const GENDER_LABEL = new Map<string, string>(GENDERS.map((g) => [g.code, g.label]))
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "Tue, 2 Jun 2099" for a YYYY-MM-DD business date. Pure: no locale or zone lookup. */
export function routeDayLabel(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number)
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
  return `${weekday}, ${d} ${MONTHS[m - 1]} ${y}`
}

const TAP = 'min-h-11 px-4 text-base'

function CollectForm({ stop, onDone, onCancel }: { stop: RouteStop; onDone: (text: string) => void; onCancel: () => void }) {
  const router = useRouter()
  const id = useId()
  const tubes = stop.tests.filter((t) => t.status === 'scheduled' && t.sampleId !== null)
  const [values, setValues] = useState<string[]>(() => tubes.map(() => ''))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setError(null)
    const entered = values.map((v) => v.trim()).filter((v) => v !== '')
    if (entered.length === 0) { setError('Enter the sample ID of at least one tube, or use "Could not collect".'); return }
    const seen = new Set<string>()
    for (const v of entered) {
      const parsed = parseSampleId(v)
      if (!parsed || seen.has(parsed.canonical)) { setError(`Sample ID ${v} is not valid. Re-scan or re-type it.`); return }
      seen.add(parsed.canonical)
    }
    setSubmitting(true)
    const r = await collectVisit(stop.visitId, entered)
    setSubmitting(false)
    if (!r.ok) { setError(r.error); return }
    const missed = r.data.notCollectedOrderIds.length
    onDone(`Saved: ${r.data.collectedOrderIds.length} collected${missed > 0 ? `, ${missed} not collected (back on the waiting list)` : ''}.`)
    router.refresh()
  }

  return (
    <form
      className="mt-3 space-y-3 rounded-md border border-border p-3"
      onSubmit={(e) => { e.preventDefault(); void submit() }}
      aria-label={`Collect samples for ${stop.patient.name}`}
    >
      <p className="text-sm text-muted-foreground">Leave a tube empty if it was not collected.</p>
      {tubes.map((t, i) => (
        <div key={t.orderId}>
          <label htmlFor={`${id}-${t.orderId}`} className="block text-sm">
            <span className="font-medium">{t.testName}</span>
            {t.container && <span className="text-muted-foreground"> · {SAMPLE_CONTAINER_LABEL[t.container]}</span>}
            <span className="block text-xs text-muted-foreground">Scan or type the tube&apos;s sample ID</span>
          </label>
          <input
            id={`${id}-${t.orderId}`}
            value={values[i]}
            onChange={(e) => setValues((vs) => vs.map((v, j) => (j === i ? e.target.value : v)))}
            className={`${FIELD} min-h-11 font-mono text-base`}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={32}
            placeholder={t.sampleId ? displaySampleId(t.sampleId) : undefined}
          />
        </div>
      ))}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className={TAP} disabled={submitting}>{submitting ? 'Saving…' : 'Save collection'}</Button>
        <Button type="button" variant="outline" className={TAP} onClick={onCancel}>Back</Button>
      </div>
    </form>
  )
}

function StopCard({ stop }: { stop: RouteStop }) {
  const headingId = useId()
  const [collecting, setCollecting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const a = stop.address
  const gender = stop.patient.gender ? (GENDER_LABEL.get(stop.patient.gender) ?? stop.patient.gender) : null

  return (
    <article aria-labelledby={headingId} className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium">{stop.windowLabel} · {stop.windowStart}–{stop.windowEnd}</p>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[stop.status]}`}>{STATUS_LABEL[stop.status]}</span>
      </div>
      <h2 id={headingId} className="mt-2 text-lg font-semibold">{stop.patient.name}</h2>
      <p className="text-sm text-muted-foreground">
        {stop.patient.uhid ? `UHID ${stop.patient.uhid} · ` : ''}{stop.patient.ageYears} y{gender ? ` · ${gender}` : ''}
      </p>

      <address className="mt-3 not-italic text-sm">
        <span className="block">{[a.line1, a.line2].filter(Boolean).join(', ')}</span>
        <span className="block">{[a.city, a.district].filter(Boolean).join(', ')} {a.pinCode}</span>
        {a.landmark && <span className="block text-muted-foreground">Landmark: {a.landmark}</span>}
      </address>
      <a href={`tel:${stop.contactPhone}`} className="mt-2 inline-flex min-h-11 items-center rounded-md border border-border px-4 text-base font-medium">
        Call {stop.contactPhone}
      </a>
      {stop.notes && <p className="mt-2 text-sm"><span className="text-muted-foreground">Note: </span>{stop.notes}</p>}

      <ul className="mt-3 divide-y divide-border rounded-md border border-border" aria-label={`Tubes for ${stop.patient.name}`}>
        {stop.tests.map((t) => (
          <li key={t.orderId} className="p-3 text-sm">
            <span className="block font-medium">{t.testName}</span>
            <span className="block text-muted-foreground">{t.container ? SAMPLE_CONTAINER_LABEL[t.container] : 'Container not set'}</span>
            {t.sampleId ? <span className="block font-mono">{displaySampleId(t.sampleId)}</span> : <span className="block">No sample ID</span>}
          </li>
        ))}
        {stop.tests.length === 0 && <li className="p-3 text-sm text-muted-foreground">No tests on this visit.</li>}
      </ul>

      <p aria-live="polite" className="mt-2 text-sm text-success">{message}</p>

      {stop.status === 'booked' && !collecting && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Button className={TAP} onClick={() => { setMessage(null); setCollecting(true) }}>Mark collected</Button>
          <Button variant="outline" className={TAP} onClick={() => setCancelling(true)}>Could not collect</Button>
        </div>
      )}
      {stop.status === 'booked' && collecting && (
        <CollectForm stop={stop} onCancel={() => setCollecting(false)} onDone={(text) => { setCollecting(false); setMessage(text) }} />
      )}
      {cancelling && (
        <CancelVisitDialog
          visit={{ id: stop.visitId, patientName: stop.patient.name }}
          reasons={COLLECTOR_CANCEL_REASONS}
          onClose={() => setCancelling(false)}
        />
      )}
    </article>
  )
}

export function CollectorRoute({ date, today, canLookBack, stops }: { date: string; today: string; canLookBack: boolean; stops: RouteStop[] }) {
  const prev = addDaysIso(date, -1)
  const showPrev = canLookBack || prev >= today
  return (
    <div className="mx-auto w-full max-w-xl space-y-4 px-4 py-4 sm:px-0">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">My route</h1>
        <p className="text-sm text-muted-foreground">{routeDayLabel(date)}{date === today ? ' (today)' : ''} · {stops.length} {stops.length === 1 ? 'stop' : 'stops'}</p>
        <nav aria-label="Route day" className="flex gap-2">
          {showPrev && <Link href={`/collections?date=${prev}`} aria-label="Previous day" className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm">‹ Prev</Link>}
          {date !== today && <Link href="/collections" className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm">Today</Link>}
          <Link href={`/collections?date=${addDaysIso(date, 1)}`} aria-label="Next day" className="inline-flex min-h-11 items-center rounded-md border border-border px-4 text-sm">Next ›</Link>
        </nav>
      </header>
      {stops.length === 0
        ? <p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">No visits assigned for this day.</p>
        : stops.map((s) => <StopCard key={s.visitId} stop={s} />)}
    </div>
  )
}
