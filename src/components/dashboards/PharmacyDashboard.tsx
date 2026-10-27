'use client'
import { Fragment, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertTriangle, XCircle, Pill, PackagePlus, PackageCheck, Clock, Search, CalendarClock, CalendarX, ChevronDown, ChevronRight, PackageSearch } from 'lucide-react'
import { KpiTile } from '@/components/dashboards/KpiTile'
import type { PharmacyKpi } from '@/lib/queries/hospital-kpis'
import { Button } from '@/components/ui/button'
import { DispenseMedicationModal } from '@/components/DispenseMedicationModal'
import { MedicationPriceEditor } from '@/components/MedicationPriceEditor' // WS2 T8
import { AddMedicationModal } from '@/components/AddMedicationModal'
import { ReceiveStockDialog } from '@/components/pharmacy/ReceiveStockDialog' // WS5 T3
import { BatchList, expiryLabel } from '@/components/pharmacy/BatchList' // WS5 T4
import { EmptyState } from '@/components/ui/empty-state' // WS5 T4
import { useToast } from '@/components/ui/toast' // WS5 T4
import { sendJson } from '@/lib/client-fetch' // WS5 T4
import { formatIsoDate, todayIsoIn } from '@/lib/india-time' // WS5 T4
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

// WS5 T4: the ?stock= filters. out/low follow stockStatus; expiring/expired look at live batch
// stock (expiring = within 90 days and not yet expired), computed server-side on the IST date.
export type StockFilter = 'out' | 'low' | 'expiring' | 'expired'

const FILTER_LABELS: Record<StockFilter, string> = {
  out: 'out of stock',
  low: 'low stock',
  expiring: 'expiring within 90 days',
  expired: 'holding expired stock',
}

export function matchesStockFilter(m: MedicationWithInventory, filter: StockFilter): boolean {
  if (filter === 'expiring') return m.expiringSoonQty > 0
  if (filter === 'expired') return m.expiredQty > 0
  return stockStatus(m.quantityOnHand, m.reorderThreshold) === filter
}

const CARD_SURFACE = 'rounded-md border border-border bg-card shadow-none'

function StockPill({ status }: { status: StockStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  )
}

function ExpiryChip({ m }: { m: MedicationWithInventory }) {
  if (m.expiredQty > 0) return <span className={`ml-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES.out}`}>Expired</span>
  if (m.expiringSoonQty > 0) return <span className={`ml-1 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES.low}`}>Expiring</span>
  return null
}

// WS5 T4: inline reorder-level edit (stock roles only). Mounted only while editing, so the toast
// context is needed only then.
function ReorderLevelEditor({ m, onDone }: { m: MedicationWithInventory; onDone: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [value, setValue] = useState(String(m.reorderThreshold))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = Number(value)
  const valid = value.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 100_000

  async function save() {
    setSaving(true)
    setError(null)
    const res = await sendJson(`/api/pharmacy/medications/${m.id}/reorder`, 'PATCH', { reorderThreshold: n })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    toast.show({ title: 'Reorder level saved' })
    router.refresh()
    onDone()
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      <input aria-label={`Reorder level of ${m.name}`} type="number" min={0} max={100000} value={value} onChange={(e) => setValue(e.target.value)} className="w-20 rounded-md border border-border px-2 py-1 text-sm" />
      <Button size="sm" disabled={!valid || saving} onClick={save}>Save</Button>
      <Button size="sm" variant="outline" disabled={saving} onClick={onDone}>Cancel</Button>
      {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
    </div>
  )
}

// WS5 T4: resolve a "Not in catalog" prescription name by linking its unlinked active episodes
// to a catalogue drug.
function LinkToDrugForm({ name, medications, onDone }: { name: string; medications: MedicationWithInventory[]; onDone: () => void }) {
  const router = useRouter()
  const toast = useToast()
  const [medicationId, setMedicationId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function link() {
    setSaving(true)
    setError(null)
    const res = await sendJson<{ linked: number }>('/api/pharmacy/uncatalogued/link', 'POST', { episodeName: name, medicationId: Number(medicationId) })
    setSaving(false)
    if (!res.ok) { setError(res.error); return }
    const drug = medications.find((m) => m.id === Number(medicationId))?.name ?? 'the catalogue drug'
    toast.show({ title: `${res.data.linked} prescription${res.data.linked === 1 ? '' : 's'} linked to ${drug}` })
    router.refresh()
    onDone()
  }

  return (
    <div className="mt-2 flex flex-wrap items-center justify-end gap-1">
      <select aria-label={`Catalogue drug for ${name}`} value={medicationId} onChange={(e) => setMedicationId(e.target.value)} className="rounded-md border border-border px-2 py-1 text-sm">
        <option value="">Choose a drug</option>
        {medications.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <Button size="sm" disabled={medicationId === '' || saving} onClick={link}>Link</Button>
      <Button size="sm" variant="outline" disabled={saving} onClick={onDone}>Cancel</Button>
      {error && <p role="alert" className="w-full text-right text-xs text-destructive">{error}</p>}
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
  kpis,
  stockFilter = null,
  canUseCounter = false,
  canEditPrice = false,
  today = todayIsoIn(),
}: {
  session: Session
  medications: MedicationWithInventory[]
  canDispense: boolean
  prescribedSummary: ActiveMedicationSummaryRow[]
  canAddMedication: boolean
  // Wave E P1-18: the day's dispensing figures, the ?stock= filter, and whether this role
  // works the counter (may open /pharmacy/patient-lookup and /pharmacy/billing).
  kpis: PharmacyKpi
  stockFilter?: StockFilter | null
  canUseCounter?: boolean
  canEditPrice?: boolean // WS2 T8: MEDICATION_PRICE_ROLES
  // WS5 T4: the IST business date the expiry fields were computed for (server-supplied).
  today?: string
}) {
  const [dispensing, setDispensing] = useState<MedicationWithInventory | null>(null)
  // `null` = closed; `{}` = open with no prefill (header button);
  // `{ name, medicationClass }` = open prefilled from a not-in-catalog row.
  const [addingMedication, setAddingMedication] = useState<{ name?: string; medicationClass?: string } | null>(null)
  const [receivingStock, setReceivingStock] = useState(false) // WS5 T3
  // WS5 T4: which stock row shows its batches, which reorder level is being edited, which
  // not-in-catalog name is being linked. Stock writes need canAddMedication (the stock roles).
  const [expanded, setExpanded] = useState<number | null>(null)
  const [editingReorder, setEditingReorder] = useState<number | null>(null)
  const [linking, setLinking] = useState<string | null>(null)

  const groupedSummary = groupByClass(prescribedSummary)
  const outOfStockCount = medications.filter((m) => stockStatus(m.quantityOnHand, m.reorderThreshold) === 'out').length
  const lowStockCount = medications.filter((m) => stockStatus(m.quantityOnHand, m.reorderThreshold) === 'low').length
  const activePrescriptionCount = prescribedSummary.reduce((sum, r) => sum + r.activeEpisodeCount, 0)
  const notInCatalogCount = prescribedSummary.filter((r) => !r.inCatalog).length
  const shownMedications = stockFilter ? medications.filter((m) => matchesStockFilter(m, stockFilter)) : medications
  const stockColumns = canDispense ? 8 : 7

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
        {/* WS5 T4: expiry alerts, counted in batches. */}
        <KpiTile label="Expiring in 90 days" value={kpis.expiringIn90Days} sub="Batches" href="/pharmacy?stock=expiring" icon={CalendarClock} tone={kpis.expiringIn90Days > 0 ? 'warning' : 'muted'} />
        <KpiTile label="Expired batches" value={kpis.expiredBatches} sub="Still on the shelf" href="/pharmacy?stock=expired" icon={CalendarX} tone={kpis.expiredBatches > 0 ? 'danger' : 'muted'} />
        {canUseCounter && (
          <>
            <KpiTile label="Dispensed today" value={kpis.dispensedToday} href="/pharmacy/billing" icon={PackageCheck} tone="success" />
            <KpiTile label="Awaiting billing" value={kpis.unbilledDispenses} sub="Dispensed, no bill yet" href="/pharmacy/billing" icon={Clock} tone={kpis.unbilledDispenses > 0 ? 'warning' : 'muted'} />
          </>
        )}
      </div>

      <section className={`${CARD_SURFACE} p-5`}>
        <div className="flex items-start justify-between gap-3">
          <SectionHeading>Medication Stock{stockFilter ? ` -- ${FILTER_LABELS[stockFilter]} only` : ''}</SectionHeading>
          {/* WS5 T3: a supplier delivery (GRN) adds batches and stock. */}
          {canAddMedication && <Button size="sm" onClick={() => setReceivingStock(true)}>Receive stock</Button>}
        </div>
        {stockFilter && (
          <p className="mb-3 text-xs text-muted-foreground">{shownMedications.length} of {medications.length} medications. <Link href="/pharmacy" className="font-medium text-primary hover:underline">Show all stock</Link></p>
        )}
        {shownMedications.length === 0 ? (
          stockFilter
            ? <EmptyState icon={PackageSearch} title="No medications match this filter" description={`No medication is ${FILTER_LABELS[stockFilter]} right now.`} action={{ label: 'Show all stock', href: '/pharmacy' }} />
            : <EmptyState icon={PackageSearch} title="No medications on file." />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/40 text-left">
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Medication</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Class</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">On hand</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">MRP</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reorder level</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Nearest expiry</th>
                  <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  {canDispense && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {shownMedications.map((m, i) => {
                  const status = stockStatus(m.quantityOnHand, m.reorderThreshold)
                  const open = expanded === m.id
                  return (
                    <Fragment key={m.id}>
                      <tr className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                        <td className="p-3">
                          <div className="flex items-start gap-1">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-label={`${open ? 'Hide' : 'Show'} batches of ${m.name}`}
                              onClick={() => setExpanded(open ? null : m.id)}
                              className="mt-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                              {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
                            </button>
                            <div>
                              <p className="font-medium text-foreground">{m.name}</p>
                              {m.genericName && <p className="text-xs text-muted-foreground">{m.genericName}</p>}
                              {m.commonDose && <p className="text-xs text-muted-foreground">{m.commonDose}</p>}
                            </div>
                          </div>
                        </td>
                        <td className="p-3 text-foreground">{m.medicationClass}</td>
                        <td className="p-3 text-foreground">{m.quantityOnHand} {m.unit}</td>
                        <td className="p-3"><MedicationPriceEditor medication={m} canEdit={canEditPrice} /></td>
                        <td className="p-3 text-foreground">
                          {editingReorder === m.id ? (
                            <ReorderLevelEditor m={m} onDone={() => setEditingReorder(null)} />
                          ) : (
                            <span className="inline-flex items-center gap-2">
                              <span>{m.reorderThreshold}</span>
                              {canAddMedication && (
                                <button type="button" aria-label={`Edit reorder level of ${m.name}`} onClick={() => setEditingReorder(m.id)} className="text-xs font-medium text-primary hover:underline">Edit</button>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="p-3 text-foreground">
                          {m.nearestExpiry ? (
                            <>
                              <p>{formatIsoDate(m.nearestExpiry)}</p>
                              <p className="text-xs text-muted-foreground">{expiryLabel(m.nearestExpiry, today)}</p>
                            </>
                          ) : <span className="text-muted-foreground">--</span>}
                        </td>
                        <td className="p-3"><StockPill status={status} /><ExpiryChip m={m} /></td>
                        {canDispense && (
                          <td className="p-3">
                            {/* Wave E P1-18: the counter dispenses against a prescription (patient lookup), never a free-typed patient id. */}
                            {canUseCounter
                              ? <Link href="/pharmacy/patient-lookup" className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted">Dispense</Link>
                              : <Button size="sm" variant="outline" onClick={() => setDispensing(m)}>Dispense</Button>}
                          </td>
                        )}
                      </tr>
                      {open && (
                        <tr className="border-b border-border bg-muted/20">
                          <td colSpan={stockColumns} className="px-6 py-3">
                            <BatchList batches={m.batches} unit={m.unit} today={today} canWriteOff={canAddMedication} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dispensing && (
        <DispenseMedicationModal medication={dispensing} today={today} onClose={() => setDispensing(null)} />
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
                              <>
                                <div className="flex justify-end gap-1">
                                  {/* WS5 T4: or link the name to a drug already in the catalogue. */}
                                  <Button size="sm" variant="outline" onClick={() => setLinking(row.name)}>Link to drug</Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setAddingMedication({ name: row.name, medicationClass: row.medicationClass })}
                                  >
                                    Add to catalog
                                  </Button>
                                </div>
                                {linking === row.name && <LinkToDrugForm name={row.name} medications={medications} onDone={() => setLinking(null)} />}
                              </>
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

      {receivingStock && (
        <ReceiveStockDialog medications={medications.map((m) => ({ id: m.id, name: m.name }))} onClose={() => setReceivingStock(false)} />
      )}

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
