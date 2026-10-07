'use client'
import { CLIENT_ERROR_MESSAGES, fetchJson, sendJson } from '@/lib/client-fetch'
import { formatIstDateTime } from '@/lib/india-time'
import { formatPaise } from '@/lib/format'
import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'
import { PatientPicker, type PickedPatient } from '@/components/PatientPicker'
import { LogDispenseBillModal } from '@/components/LogDispenseBillModal'
import { MessageThreadView, type MessageRow } from '@/components/MessageThreadView'
import { CHARGE_STATUS_LABELS } from '@/lib/charge-status'
import type { MedicationWithInventory } from '@/lib/queries/medications'
import type { PharmacyPatientView, PharmacyEpisode, PharmacyRosterRow } from '@/lib/queries/patients'

// The view arrives via `fetch().json()`, not as a Server Component prop, so
// `dispensedAt` (typed `Date` on the server-side PharmacyPatientView) is
// really a JSON-serialized string by the time it lands here.
type PharmacyDispense = Omit<PharmacyPatientView['dispenses'][number], 'dispensedAt'> & { dispensedAt: string }
type PharmacyPatientViewClient = Omit<PharmacyPatientView, 'dispenses'> & { dispenses: PharmacyDispense[] }

function EpisodeTable({ episodes, medicationById, onDispense }: {
  episodes: PharmacyEpisode[]
  medicationById: Map<number, MedicationWithInventory>
  onDispense?: (medication: MedicationWithInventory, episode: PharmacyEpisode) => void
}) {
  if (episodes.length === 0) return <p className="text-sm text-muted-foreground">None on file.</p>

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border bg-secondary/40 text-left">
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Medication</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Class</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dose</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Start date</th>
            {onDispense && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {episodes.map((e) => {
            const catalogMed = e.catalogMedicationId !== null ? medicationById.get(e.catalogMedicationId) : undefined
            return (
              <tr key={e.id} className="border-b border-border last:border-b-0">
                <td className="p-3 font-medium text-foreground">{e.name}</td>
                <td className="p-3 text-foreground">{e.medicationClass}</td>
                <td className="p-3 text-foreground">{e.dose ?? '—'}</td>
                <td className="p-3 text-foreground">{e.startDate}</td>
                {onDispense && (
                  <td className="p-3">
                    {e.catalogMedicationId === null || !catalogMed ? (
                      <Badge variant="outline">Not stocked</Badge>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => onDispense(catalogMed, e)}>Dispense</Button>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Minimal inline composer, not the shared MessageComposer -- that one calls
// router.refresh() to pick up a new message, which works on pages where the
// thread is server-rendered. This page's whole patient view (including the
// thread) is client-fetched on demand, so sending needs to re-fetch this
// component's own messages state instead.
function ContactDoctorComposer({ patientId, onSent }: { patientId: string; onSent: () => void }) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    if (!body.trim() || sending) return
    setSending(true)
    setError(null)
    // internal: true -- pharmacy talks to the prescriber about this
    // patient, never to the patient. Kept out of the patient portal's
    // view of this same thread (see messages.internal on schema.ts).
    const res = await sendJson(`/api/messages/${encodeURIComponent(patientId)}`, 'POST', { body, actingAs: 'provider', internal: true })
    setSending(false)
    if (res.ok) { setBody(''); onSent(); return }
    setError(res.error)
  }

  return (
    <div>
      {error && <p role="alert" className="mb-2 text-xs text-destructive">{error}</p>}
      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          rows={2}
          placeholder="Ask the prescriber to confirm…"
          className="flex-1 rounded-md border border-border px-3 py-2 text-sm"
        />
        <button
          onClick={send}
          disabled={sending || !body.trim()}
          className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          Send
        </button>
      </div>
    </div>
  )
}

export function PharmacyPatientLookup({ medications, roster }: { medications: MedicationWithInventory[]; roster: PharmacyRosterRow[] }) {
  const [picked, setPicked] = useState<PickedPatient | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<PharmacyPatientViewClient | null>(null)
  const [dispensingEpisode, setDispensingEpisode] = useState<{ medication: MedicationWithInventory; episode: PharmacyEpisode } | null>(null)
  const [billingDispense, setBillingDispense] = useState<PharmacyDispense | null>(null)
  const [messages, setMessages] = useState<MessageRow[]>([])

  const medicationById = new Map(medications.map((m) => [m.id, m]))

  async function refreshMessages(forPatientId: string) {
    const res = await fetch(`/api/messages/${encodeURIComponent(forPatientId)}?actingAs=provider`)
    if (res.ok) setMessages(await res.json())
  }

  async function lookup(id: string) {
    if (!id.trim()) return
    setLoading(true)
    setError(null)
    setView(null)
    setMessages([])
    const res = await fetchJson<PharmacyPatientViewClient>(`/api/pharmacy/patients/${encodeURIComponent(id)}`)
    setLoading(false)
    if (res.ok) {
      const v = res.data
      setView(v)
      setPicked({ id: v.id, name: v.name, uhid: v.uhid ?? null })
      refreshMessages(id)
      return
    }
    setError(res.status === 404 && res.error === CLIENT_ERROR_MESSAGES.notFound ? 'No patient with that ID' : res.error)
  }

  // Re-fetches the same chart after a dispense or a bill is logged, so the
  // dispense history / charge cells reflect the write without a full page
  // reload (this component owns its own state -- `router.refresh()` alone
  // wouldn't re-run this component's own `fetch`).
  async function refreshLookup() {
    if (!view) return
    const res = await fetch(`/api/pharmacy/patients/${encodeURIComponent(view.id)}`)
    if (res.ok) setView(await res.json())
  }

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Patients with Active Prescriptions ({roster.length})
        </h2>
        {roster.length === 0 ? (
          <p className="text-sm text-muted-foreground">No patients currently have an active prescription on file.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {roster.map((r) => (
              <button
                key={r.id}
                onClick={() => { setPicked({ id: r.id, name: r.name, uhid: null }); void lookup(r.id) }}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                  view?.id === r.id ? 'border-primary bg-primary/10 text-primary' : 'border-border text-foreground hover:bg-secondary'
                }`}
              >
                {r.name} <span className="text-xs text-muted-foreground">· {r.activeMedicationCount} active</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* Wave C P0-04: find the patient by name, UHID, mobile or chart id. */}
      <div className="max-w-xl">
        <PatientPicker
          value={picked}
          onChange={(p) => {
            setPicked(p)
            if (p) void lookup(p.id)
            else { setView(null); setMessages([]); setError(null) }
          }}
        />
        {loading && <p role="status" className="mt-1 text-xs text-muted-foreground">Looking up…</p>}
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {view && (
        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Identity</h2>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Name</p><p className="font-medium text-foreground">{view.name}</p></div>
              <div><p className="text-xs text-muted-foreground">DOB</p><p className="font-medium text-foreground">{view.dob}</p></div>
              <div><p className="text-xs text-muted-foreground">UHID</p><p className="font-medium text-foreground">{view.uhid ?? '—'}</p><p className="font-mono text-[11px] text-muted-foreground">Chart ID {view.id}</p></div>
              <div><p className="text-xs text-muted-foreground">Current provider</p><p className="font-medium text-foreground">{view.currentProvider ?? '—'}</p></div>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Active medications</h2>
            <EpisodeTable
              episodes={view.activeMedications}
              medicationById={medicationById}
              onDispense={(medication, episode) => setDispensingEpisode({ medication, episode })}
            />
          </Card>

          <details className="rounded-xl border border-primary/10 bg-card/80 p-5 shadow-sm">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Past medications ({view.pastMedications.length})
            </summary>
            <div className="mt-3">
              <EpisodeTable episodes={view.pastMedications} medicationById={medicationById} />
            </div>
          </details>

          <Card className="p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dispense history</h2>
            {view.dispenses.length === 0 ? (
              <p className="text-sm text-muted-foreground">No dispenses on file.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-secondary/40 text-left">
                      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Medication</th>
                      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quantity</th>
                      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Dispensed by</th>
                      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
                      <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Billed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.dispenses.map((d) => (
                      <tr key={d.id} className="border-b border-border last:border-b-0">
                        <td className="p-3 font-medium text-foreground">{d.medicationName}</td>
                        <td className="p-3 text-foreground">{d.quantity}</td>
                        <td className="p-3 text-foreground">{d.dispensedByName}</td>
                        <td className="p-3 text-foreground">{formatIstDateTime(d.dispensedAt)}</td>
                        <td className="p-3">
                          {d.charge === null ? (
                            <Button size="sm" variant="outline" onClick={() => setBillingDispense(d)}>Log bill</Button>
                          ) : (
                            <span className="text-foreground">{CHARGE_STATUS_LABELS[d.charge.status]} · {formatPaise(d.charge.amountCents)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Contact {view.currentProvider ?? 'Prescriber'}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Use this to confirm a substitution, a dose question, or anything else before dispensing -- {view.currentProvider ?? 'the prescriber'} sees
              it in this patient&apos;s thread, but it is an internal note: the patient never sees it in their portal.
            </p>
            <div className="mb-4 max-h-64 overflow-y-auto rounded-lg border border-border p-3">
              <MessageThreadView messages={messages} viewerRole="provider" />
            </div>
            <ContactDoctorComposer patientId={view.id} onSent={() => refreshMessages(view.id)} />
          </Card>
        </div>
      )}

      {dispensingEpisode && view && (
        <DispenseMedicationModal
          medication={dispensingEpisode.medication}
          initialPatientId={view.id}
          medicationEpisodeId={dispensingEpisode.episode.id}
          onClose={() => setDispensingEpisode(null)}
          onDispensed={refreshLookup}
        />
      )}

      {billingDispense && view && (
        <LogDispenseBillModal
          dispense={billingDispense}
          diagnoses={view.diagnoses}
          onClose={() => setBillingDispense(null)}
          onLogged={refreshLookup}
        />
      )}
    </div>
  )
}
