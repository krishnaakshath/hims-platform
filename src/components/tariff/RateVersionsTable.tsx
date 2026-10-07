'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { formatPaise } from '@/lib/money'
import { ConfirmDialog } from './ConfirmDialog'
import { ReviseRateModal } from './ReviseRateModal'
import { FIELD_CLASS, formatIsoDate, sendJson } from './api'

export interface RateListItem {
  id: number
  scope: 'base' | 'department' | 'payer'
  departmentName: string | null
  payerName: string | null
  roomCategoryCode: string | null
  ward: string | null
  amountPaise: number
  validFrom: string
  validTo: string | null
  deactivated: boolean
}

export { rateStatus, type RateStatus } from './status'
import { rateStatus, type RateStatus } from './status'

const STATUS_LABEL: Record<RateStatus, string> = { current: 'Current', scheduled: 'Scheduled', ended: 'Ended', deactivated: 'Deactivated' }
const SCOPES = [
  { scope: 'base', heading: 'Base price' },
  { scope: 'department', heading: 'Department price list' },
  { scope: 'payer', heading: 'Payer rates' },
] as const
const TH = 'p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground'

function groupLabel(r: RateListItem): string {
  const who = r.scope === 'department' ? r.departmentName ?? 'Unknown department' : r.scope === 'payer' ? r.payerName ?? 'Unknown payer' : 'All patients'
  const room = r.roomCategoryCode ? `Room ${r.roomCategoryCode}` : 'Any room category'
  const ward = r.ward ? `Ward ${r.ward}` : 'any ward'
  return `${who} · ${room} · ${ward}`
}

export function RateVersionsTable({ rates, today }: { rates: RateListItem[]; today: string }) {
  const router = useRouter()
  const [revising, setRevising] = useState<RateListItem | null>(null)
  const [ending, setEnding] = useState<RateListItem | null>(null)
  const [deactivating, setDeactivating] = useState<RateListItem | null>(null)
  const [endDate, setEndDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (rates.length === 0) {
    return <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No rates yet. Add a base price to start.</p>
  }

  async function patch(r: RateListItem, body: unknown, done: () => void) {
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/tariff/rates/${r.id}`, 'PATCH', body)
    setBusy(false)
    if (res.ok) { done(); router.refresh(); return }
    setError(res.error)
  }

  return (
    <div className="space-y-6">
      {SCOPES.map(({ scope, heading }) => {
        const inScope = rates.filter((r) => r.scope === scope)
        if (inScope.length === 0) return null
        const groups = new Map<string, RateListItem[]>()
        for (const r of inScope) {
          const k = groupLabel(r)
          groups.set(k, [...(groups.get(k) ?? []), r])
        }
        return (
          <section key={scope} aria-labelledby={`scope-${scope}`}>
            <h3 id={`scope-${scope}`} className="mb-2 text-base font-semibold">{heading}</h3>
            <div className="space-y-4">
              {[...groups].map(([label, list]) => (
                <div key={label} className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full border-collapse text-sm">
                    <caption className="bg-secondary/40 p-3 text-left text-sm font-medium">{label}</caption>
                    <thead>
                      <tr className="border-b border-border">
                        <th scope="col" className={`${TH} text-right`}>Amount</th>
                        <th scope="col" className={TH}>Valid from</th>
                        <th scope="col" className={TH}>Valid to</th>
                        <th scope="col" className={TH}>Status</th>
                        <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => {
                        const status = rateStatus(r, today)
                        const live = status === 'current' || status === 'scheduled'
                        return (
                          <tr key={r.id} className="border-b border-border last:border-b-0">
                            <td className="whitespace-nowrap p-3 text-right font-medium">{formatPaise(r.amountPaise)}</td>
                            <td className="whitespace-nowrap p-3">{formatIsoDate(r.validFrom)}</td>
                            <td className="whitespace-nowrap p-3">{r.validTo ? formatIsoDate(r.validTo) : 'Open-ended'}</td>
                            <td className="p-3">{STATUS_LABEL[status]}</td>
                            <td className="whitespace-nowrap p-3 text-right">
                              {live && <Button variant="outline" size="sm" aria-label={`Revise rate ${formatPaise(r.amountPaise)} from ${formatIsoDate(r.validFrom)}`} onClick={() => setRevising(r)}>Revise</Button>}
                              {live && <Button variant="outline" size="sm" className="ml-2" aria-label={`End rate ${formatPaise(r.amountPaise)} from ${formatIsoDate(r.validFrom)} on a date`} onClick={() => { setError(null); setEndDate(r.validTo ?? ''); setEnding(r) }}>End on date</Button>}
                              {status !== 'deactivated' && <Button variant="outline" size="sm" className="ml-2" aria-label={`Deactivate rate ${formatPaise(r.amountPaise)} from ${formatIsoDate(r.validFrom)}`} onClick={() => { setError(null); setDeactivating(r) }}>Deactivate</Button>}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </section>
        )
      })}

      {revising && <ReviseRateModal rate={{ id: revising.id, amountPaise: revising.amountPaise, validFrom: revising.validFrom, validTo: revising.validTo }} today={today} onClose={() => setRevising(null)} />}

      {ending && (
        <Dialog open onOpenChange={(o) => { if (!o) setEnding(null) }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>End rate on a date</DialogTitle></DialogHeader>
            <div>
              <label htmlFor="end-date" className="mb-1 block text-xs font-medium text-muted-foreground">End date</label>
              <input id="end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={FIELD_CLASS} />
            </div>
            <p className="text-sm text-muted-foreground">
              {endDate ? `${formatPaise(ending.amountPaise)} will apply up to and including ${formatIsoDate(endDate)}.` : 'Choose the last day this rate applies.'}
            </p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setEnding(null)} disabled={busy}>Cancel</Button>
              <Button disabled={busy || !endDate} onClick={() => void patch(ending, { validTo: endDate }, () => setEnding(null))}>End rate</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {deactivating && (
        <ConfirmDialog
          title="Deactivate rate"
          message={`Deactivate the ${formatPaise(deactivating.amountPaise)} rate from ${formatIsoDate(deactivating.validFrom)}? It will no longer be used for pricing. This cannot be undone here.`}
          confirmLabel="Deactivate rate"
          busy={busy}
          error={error}
          onConfirm={() => void patch(deactivating, { deactivate: true }, () => setDeactivating(null))}
          onCancel={() => setDeactivating(null)}
        />
      )}
    </div>
  )
}
