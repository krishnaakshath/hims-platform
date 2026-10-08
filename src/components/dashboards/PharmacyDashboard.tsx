'use client'
import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, XCircle, Pill, PackagePlus, PackageCheck, Clock, Search } from 'lucide-react'
import { KpiTile } from '@/components/dashboards/KpiTile'
import type { PharmacyKpi } from '@/lib/queries/hospital-kpis'
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
  kpis,
  stockFilter = null,
  canUseCounter = false,
}: {
  session: Session
  medications: MedicationWithInventory[]
  canDispense: boolean
  prescribedSummary: ActiveMedicationSummaryRow[]
  canAddMedication: boolean
  // Wave E P1-18: the day's dispensing figures, the ?stock= filter, and whether this role
  // works the counter (may open /pharmacy/patient-lookup and /pharmacy/billing).
  kpis: PharmacyKpi
  stockFilter?: 'out' | 'low' | null
  canUseCounter?: boolean
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
  const shownMedications = stockFilter ? medications.filter((m) => stockStatus(m.quantityOnHand, m.reorderThreshold) === stockFilter) : medications

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Hello, {session.name}!</h1>
          <p className="text-sm text-muted-foreground">Here&apos;s the dispensing counter, at a glance.</p>
        </div>
        {canUseCounter && (
          <Link href="/pharmacy/patient-lookup" className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Search className="h-4 w-4" aria-hidden="true" />Dispense against a prescription
          </Link>
        )}
      </div>

      {/* Wave E P1-18: every tile drills somewhere -- stock tiles filter the table below. */}
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <KpiTile label="Out of Stock" value={outOfStockCount} href="/pharmacy?stock=out" icon={XCircle} tone="danger" />
        <KpiTile label="Low Stock" value={lowStockCount} href="/pharmacy?stock=low" icon={AlertTriangle} tone="warning" />
        <KpiTile label="Active Prescriptions" value={activePrescriptionCount} href="/pharmacy#prescribed" icon={Pill} />
        <KpiTile label="Not in Catalog" value={notInCatalogCount} href="/pharmacy#prescribed" icon={PackagePlus} tone="muted" />
        {canUseCounter && (
          <>
            <KpiTile label="Dispensed today" value={kpis.dispensedToday} href="/pharmacy/billing" icon={PackageCheck} tone="success" />
            <KpiTile label="Awaiting billing" value={kpis.unbilledDispenses} sub="Dispensed, no bill yet" href="/pharmacy/billing" icon={Clock} tone={kpis.unbilledDispenses > 0 ? 'warning' : 'muted'} />
          </>
        )}
      </div>

      <section className={`${CARD_SURFACE} p-5`}>
        <SectionHeading>Medication Stock{stockFilter ? ` -- ${STATUS_LABELS[stockFilter].toLowerCase()} only` : ''}</SectionHeading>
        {stockFilter && (
          <p className="mb-3 text-xs text-muted-foreground">{shownMedications.length} of {medications.length} medications. <Link href="/pharmacy" className="font-medium text-primary hover:underline">Show all stock</Link></p>
        )}
        {shownMedications.length === 0 ? (
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
                {shownMedications.map((m, i) => {
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
                          {/* Wave E P1-18: the counter dispenses against a prescription (patient lookup), never a free-typed patient id. */}
                          {canUseCounter
                            ? <Link href="/pharmacy/patient-lookup" className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted">Dispense</Link>
                            : <Button size="sm" variant="outline" onClick={() => setDispensing(m)}>Dispense</Button>}
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
      <section id="prescribed" className={`${CARD_SURFACE} mt-6 p-5`}>
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
