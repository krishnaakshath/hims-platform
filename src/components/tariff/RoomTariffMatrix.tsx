import Link from 'next/link'
import { formatPaise } from '@/lib/money'
import { formatIsoDate } from './api'
import { rateStatus } from './status'

export interface MatrixService { id: number; code: string; name: string }
export interface MatrixCategory { id: number; code: string; name: string }
export interface MatrixRate {
  serviceId: number
  scope: 'base' | 'department' | 'payer'
  roomCategoryId: number | null
  ward: string | null
  amountPaise: number
  validFrom: string
  validTo: string | null
  deactivated: boolean
}

const TH = 'p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** Read-only grid of the CURRENT per-day base rate per room-rent service and room category. Edit on the service page. */
export function RoomTariffMatrix({ services, rates, categories, today }: { services: MatrixService[]; rates: MatrixRate[]; categories: MatrixCategory[]; today: string }) {
  if (services.length === 0) {
    return <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No room-rent services yet. Create a service in the Room rent category to price rooms.</p>
  }
  const current = rates.filter((r) => r.scope === 'base' && rateStatus(r, today) === 'current')
  const cell = (serviceId: number, categoryId: number | null): number | null =>
    current.find((r) => r.serviceId === serviceId && r.roomCategoryId === categoryId && r.ward === null)?.amountPaise ?? null
  const overrides = current.filter((r) => r.ward !== null)
  const byId = new Map(services.map((s) => [s.id, s]))
  const catById = new Map(categories.map((c) => [c.id, c]))

  return (
    <div className="space-y-6">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Current per-day base rate by room category</caption>
          <thead>
            <tr className="border-b border-border bg-secondary/40">
              <th scope="col" className={TH}>Service</th>
              <th scope="col" className={`${TH} text-right`}>Any category</th>
              {categories.map((c) => <th key={c.id} scope="col" className={`${TH} text-right`}>{c.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {services.map((s) => (
              <tr key={s.id} className="border-b border-border last:border-b-0">
                <th scope="row" className="p-3 text-left font-medium">
                  <Link href={`/tariffs/services/${s.id}`} className="text-primary underline-offset-2 hover:underline">{s.name}</Link>
                </th>
                {[null, ...categories.map((c) => c.id)].map((cid) => {
                  const paise = cell(s.id, cid)
                  return <td key={cid ?? 'any'} className="whitespace-nowrap p-3 text-right">{paise === null ? '—' : formatPaise(paise)}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section aria-label="Ward overrides" className="space-y-2">
        <h3 className="text-base font-semibold">Ward overrides</h3>
        {overrides.length === 0 ? (
          <p className="text-sm text-muted-foreground">No ward-specific overrides are in effect today.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border text-sm">
            {overrides.map((r, i) => (
              <li key={i} className="flex flex-wrap items-center gap-x-4 gap-y-1 p-3">
                <span className="font-medium">{byId.get(r.serviceId)?.name ?? 'Service'}</span>
                <span>{r.roomCategoryId === null ? 'Any category' : catById.get(r.roomCategoryId)?.name ?? 'Category'}</span>
                <span>Ward: {r.ward}</span>
                <span className="ml-auto font-medium">{formatPaise(r.amountPaise)}</span>
                <span className="text-xs text-muted-foreground">from {formatIsoDate(r.validFrom)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
