'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Pill } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { AddPrescriptionModal } from '@/components/AddPrescriptionModal'
import type { medicationEpisodes } from '@/db/schema'
import type { MedicationWithInventory } from '@/lib/queries/medications'

export interface PrescriberInfo { name: string; credentials: string | null; specialty: string }

// Matches medical-record/page.tsx's own (page-local, unexported)
// SECTION_HEADING convention -- duplicated here rather than imported, the
// same way CarePlanSection.tsx:14 deliberately does, since this component
// owns its own heading row (no page-level <h2> sits above it any more --
// see page.tsx's Medication History section).
const SECTION_HEADING = 'border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground'

// Copied from medical-record/page.tsx:25 -- it already tolerates both a
// real Date instance (a fresh DB read) and an ISO string (the shape a
// `prescribedAt` timestamp comes back as on a Redis cache hit, since JSON
// has no Date type). Review Focus #5 depends on this.
function formatDate(value: string | Date | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

type Episode = typeof medicationEpisodes.$inferSelect

function MedicationRow({
  episode, prescriberById, canPrescribe, patientId,
}: {
  episode: Episode
  prescriberById: Record<number, PrescriberInfo>
  canPrescribe: boolean
  patientId: string
}) {
  const router = useRouter()
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const m = episode

  const prescriber = m.prescribedByProviderId != null ? prescriberById[m.prescribedByProviderId] : undefined

  // Sig line: keep today's "{dose} · started {date}" shape and insert the
  // new segments in between -- omitting whatever is null is what makes an
  // imported row (every new column null) byte-identical to today's output.
  const sigParts = [m.dose ?? 'Dose not recorded']
  if (m.frequencyPerDay != null) sigParts.push(`${m.frequencyPerDay} times daily`)
  if (m.durationDays != null) sigParts.push(`${m.durationDays} days`)
  sigParts.push(`started ${formatDate(m.startDate)}`)
  if (m.status === 'inactive' && m.stopDate) sigParts.push(`stopped ${formatDate(m.stopDate)}`)
  const sigLine = sigParts.join(' · ')

  // Prescriber line, gated on prescribedAt being set -- never on
  // prescribedByProviderId, per the brief. A prescriberById miss (a
  // deactivated/unresolvable provider id) degrades to a line with no
  // name/specialty rather than crashing the whole section.
  let prescriberLine: string | null = null
  if (m.prescribedAt) {
    const nameWithCredentials = prescriber ? `${prescriber.name}${prescriber.credentials ? `, ${prescriber.credentials}` : ''}` : null
    const parts = [`Prescribed by${nameWithCredentials ? ` ${nameWithCredentials}` : ''}`]
    if (prescriber?.specialty) parts.push(prescriber.specialty)
    parts.push(formatDate(m.prescribedAt))
    prescriberLine = parts.join(' · ')
    if (m.enteredByName && m.enteredByName !== prescriber?.name) prescriberLine += ` · Entered by ${m.enteredByName}`
  }

  async function stop() {
    setStopping(true)
    setError(null)
    const res = await fetch(`/api/patients/${patientId}/prescriptions/${m.id}`, { method: 'PATCH' })
    setStopping(false)
    if (res.ok) { router.refresh(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not stop this prescription.')
  }

  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm">
      <Pill className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{m.name} <span className="font-normal text-muted-foreground">({m.medicationClass})</span></p>
        <p className="text-xs text-muted-foreground">{sigLine}</p>
        {m.instructions && <p className="text-xs text-muted-foreground">{m.instructions}</p>}
        {prescriberLine && <p className="text-xs text-muted-foreground">{prescriberLine}</p>}
        {(m.prescribedAt || (canPrescribe && m.status === 'active')) && (
          <div className="mt-1 flex items-center gap-3">
            {/* An imported history row gets no Print link -- the chart must
                not offer to print, as a prescription written here, a
                medication whose origin was an EHR import. */}
            {m.prescribedAt && (
              <a
                href={`/prescriptions/print?ids=${m.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-primary hover:underline"
              >
                Print
              </a>
            )}
            {/* Stop is offered on imported active episodes too (spec §5):
                discontinuing a drug is a real clinical event regardless of
                where the row came from. */}
            {canPrescribe && m.status === 'active' && (
              <Button size="xs" variant="outline" onClick={stop} disabled={stopping}>Stop</Button>
            )}
          </div>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </li>
  )
}

export function MedicationHistorySection(props: {
  patientId: string
  episodes: Episode[]
  prescriberById: Record<number, PrescriberInfo>
  catalog: MedicationWithInventory[]
  specialties: string[]
  activeProviders: { id: number; name: string; specialty: string }[]
  needsOnBehalfOf: boolean
  canPrescribe: boolean
  diagnosisCodes: string[]
}) {
  const { patientId, episodes, prescriberById, catalog, specialties, activeProviders, needsOnBehalfOf, canPrescribe, diagnosisCodes } = props
  const [adding, setAdding] = useState(false)
  const [specialtyFilter, setSpecialtyFilter] = useState('')

  // The facet only ever appears once the prescribed rows on THIS patient
  // actually span more than one specialty -- computed from the episodes in
  // front of us, not from the page's full active-roster `specialties` list
  // (a roster can carry more specialties than this patient has ever been
  // prescribed under). The dropdown's options still come from `specialties`
  // itself, never a hardcoded enum.
  const prescribedSpecialties = new Set<string>()
  for (const e of episodes) {
    if (e.prescribedAt && e.prescribedByProviderId != null) {
      const p = prescriberById[e.prescribedByProviderId]
      if (p) prescribedSpecialties.add(p.specialty)
    }
  }
  const showFacet = prescribedSpecialties.size > 1

  // Imported rows (no resolvable specialty) are always shown, regardless of
  // the active filter.
  const visibleEpisodes = specialtyFilter
    ? episodes.filter((e) => {
        if (!e.prescribedAt || e.prescribedByProviderId == null) return true
        const p = prescriberById[e.prescribedByProviderId]
        return p?.specialty === specialtyFilter
      })
    : episodes

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className={SECTION_HEADING}>Medication History</h2>
        {canPrescribe && <Button size="sm" onClick={() => setAdding(true)}>Add prescription</Button>}
      </div>

      {showFacet && (
        <div className="mb-3">
          <select
            aria-label="Filter by specialty"
            value={specialtyFilter}
            onChange={(e) => setSpecialtyFilter(e.target.value)}
            className="rounded-md border border-border px-2 py-1 text-xs"
          >
            <option value="">All specialties</option>
            {specialties.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      )}

      {visibleEpisodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No medications recorded.</p>
      ) : (
        <div className="space-y-4">
          {(['active', 'inactive'] as const).map((status) => {
            const meds = visibleEpisodes.filter((m) => m.status === status)
            if (meds.length === 0) return null
            return (
              <div key={status}>
                <p className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${status === 'active' ? 'text-emerald-700' : 'text-muted-foreground'}`}>
                  {status === 'active' ? 'Currently Taking' : 'Past Medications'}
                </p>
                <ul className="space-y-1.5">
                  {meds.map((m) => (
                    <MedicationRow key={`med-${m.id}`} episode={m} prescriberById={prescriberById} canPrescribe={canPrescribe} patientId={patientId} />
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}

      {adding && (
        <AddPrescriptionModal
          patientId={patientId}
          catalog={catalog}
          activeProviders={activeProviders}
          needsOnBehalfOf={needsOnBehalfOf}
          diagnosisCodes={diagnosisCodes}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  )
}
