'use client'
import { useState } from 'react'
import { AlertTriangle, XCircle, Pill, PackagePlus } from 'lucide-react'
import { CountUp } from '@/components/CountUp'
import { Button } from '@/components/ui/button'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'
import { AddMedicationModal } from '@/components/AddMedicationModal'
import type { MedicationWithInventory, ActiveMedicationSummaryRow } from '@/lib/queries/medications'
import type { Session } from '@/lib/auth'

type StockStatus = 'ok' | 'low' | 'out'

// Zero stock is checked as its own branch, not folded into the "below
// threshold" comparison -- a medication with quantityOnHand === 0 must
// always render "out of stock", even if reorderThreshold is also 0 (which
// would make `quantityOnHand <= reorderThreshold` true for the wrong reason).
function stockStatus(quantityOnHand: number, reorderThreshold: number): StockStatus {
  if (quantityOnHand === 0) return 'out'
  if (quantityOnHand <= reorderThreshold) return 'low'
  return 'ok'
}

const STATUS_STYLES: Record<StockStatus, string> = {
  ok: 'border-success/30 bg-success/10 text-success',
  low: 'border-warning/30 bg-warning/10 text-warning',
  out: 'border-destructive/30 bg-destructive/10 text-destructive',
}

const STATUS_LABELS: Record<StockStatus, string> = {
  ok: 'OK',
  low: 'Low stock',
  out: 'Out of stock',
}

const CARD_SURFACE = 'rounded-md border border-border bg-card shadow-none'

function StockPill({ status }: { status: StockStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  )
}

// Same visual language as MiniStatTile in the other dashboards, minus the
// Link wrapper -- there's no separate drill-down page for any of these
// counts, so a non-navigable tile is the honest affordance here.
function StatTile({ value, label, icon: Icon, tone }: { value: number; label: string; icon: React.ComponentType<{ className?: string }>; tone: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border bg-card p-4">
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone}`} aria-hidden="true">
        <Icon className="h-4.5 w-4.5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-foreground"><CountUp to={value} /></p>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      </div>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 border-l-2 border-primary/40 pl-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
}

// Groups the already-sorted (by medicationClass, then count desc) summary
// rows by class, preserving the query's own ordering rather than
// re-sorting -- a Map (not a plain object) keeps insertion order stable
// regardless of what the class strings look like.
function groupByClass(rows: ActiveMedicationSummaryRow[]): Map<string, ActiveMedicationSummaryRow[]> {
  const groups = new Map<string, ActiveMedicationSummaryRow[]>()
  for (const row of rows) {
    const existing = groups.get(row.medicationClass)
    if (existing) existing.push(row)
    else groups.set(row.medicationClass, [row])
  }
  return groups
}

export function PharmacyDashboard({
  session,
  medications,
  canDispense,
  prescribedSummary,
  canAddMedication,
}: {
  session: Session
  medications: MedicationWithInventory[]
  canDispense: boolean
  prescribedSummary: ActiveMedicationSummaryRow[]
  canAddMedication: boolean
}) {
  const [dispensing, setDispensing] = useState<MedicationWithInventory | null>(null)
  // `null` = closed; `{}` = open with no prefill (header button);
  // `{ name, medicationClass }` = open prefilled from a not-in-catalog row.
  const [addingMedication, setAddingMedication] = useState<{ name?: string; medicationClass?: string } | null>(null)

  const groupedSummary = groupByClass(prescribedSummary)
  const outOfStockCount = medications.filter((m) => stockStatus(m.quantityOnHand, m.reorderThreshold) === 'out').length
  const lowStockCount = medications.filter((m) => stockStatus(m.quantityOnHand, m.reorderThreshold) === 'low').length
  const activePrescriptionCount = prescribedSummary.reduce((sum, r) => sum + r.activeEpisodeCount, 0)
  const notInCatalogCount = prescribedSummary.filter((r) => !r.inCatalog).length

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s the dispensing counter, at a glance.</p>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile value={outOfStockCount} label="Out of Stock" icon={XCircle} tone="bg-destructive/10 text-destructive" />
        <StatTile value={lowStockCount} label="Low Stock" icon={AlertTriangle} tone="bg-warning/10 text-warning" />
        <StatTile value={activePrescriptionCount} label="Active Prescriptions" icon={Pill} tone="bg-primary/10 text-primary" />
        <StatTile value={notInCatalogCount} label="Not in Catalog" icon={PackagePlus} tone="bg-accent/10 text-accent" />
      </div>

      <section className={`${CARD_SURFACE} p-5`}>
        <SectionHeading>Medication Stock</SectionHeading>
        {medications.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No medications on file.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Medication</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Class</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">On hand</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  {canDispense && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {medications.map((m, i) => {
                  const status = stockStatus(m.quantityOnHand, m.reorderThreshold)
                  return (
                    <tr key={m.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                      <td className="p-3">
                        <p className="font-medium text-foreground">{m.name}</p>
                        {m.genericName && <p className="text-xs text-muted-foreground">{m.genericName}</p>}
                        {m.commonDose && <p className="text-xs text-muted-foreground">{m.commonDose}</p>}
                      </td>
                      <td className="p-3 text-foreground">{m.medicationClass}</td>
                      <td className="p-3 text-foreground">{m.quantityOnHand} {m.unit}</td>
                      <td className="p-3"><StockPill status={status} /></td>
                      {canDispense && (
                        <td className="p-3">
                          <Button size="sm" variant="outline" onClick={() => setDispensing(m)}>Dispense</Button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dispensing && (
        <DispenseMedicationModal medication={dispensing} onClose={() => setDispensing(null)} />
      )}

      {/* Practice-wide "currently prescribed" summary -- counts and drug
          names only, grouped by class, never a patient identity. This is an
          aggregate a pharmacist can leave open at a counter, unlike the
          stock table above which stays exactly as it was. */}
      <section className={`${CARD_SURFACE} mt-6 p-5`}>
        <div className="mb-3 flex items-center justify-between">
          <SectionHeading>Currently Prescribed Across the Practice</SectionHeading>
          {canAddMedication && (
            <Button size="sm" onClick={() => setAddingMedication({})}>Add medication</Button>
          )}
        </div>

        {prescribedSummary.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No active prescriptions on file.</p>
        ) : (
          <div className="space-y-6">
            {Array.from(groupedSummary.entries()).map(([medicationClass, rows]) => (
              <div key={medicationClass}>
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{medicationClass}</h3>
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full border-collapse text-sm">
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={row.name} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
                          <td className="p-3">
                            <span className="font-medium text-foreground">{row.name}</span>
                            {!row.inCatalog && (
                              <span className="ml-2 inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                                Not in catalog
                              </span>
                            )}
                          </td>
                          <td className="p-3 text-right text-foreground">{row.activeEpisodeCount} active</td>
                          <td className="p-3 text-right">
                            {!row.inCatalog && canAddMedication && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setAddingMedication({ name: row.name, medicationClass: row.medicationClass })}
                              >
                                Add to catalog
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {addingMedication && (
        <AddMedicationModal
          initialName={addingMedication.name}
          initialClass={addingMedication.medicationClass}
          onClose={() => setAddingMedication(null)}
        />
      )}
    </div>
  )
}
