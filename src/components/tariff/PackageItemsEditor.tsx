'use client'
import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { packageItemsSchema, type ServiceCategory } from '@/lib/tariff/validation'
import { FIELD_CLASS, sendJson } from './api'

export interface PackageServiceOption { id: number; code: string; name: string; category: ServiceCategory }
export interface PackageItem { itemServiceId: number; code: string; name: string; quantity: number }

export function PackageItemsEditor({ packageServiceId, items, services }: { packageServiceId: number; items: PackageItem[]; services: PackageServiceOption[] }) {
  const router = useRouter()
  const uid = useId()
  const [rows, setRows] = useState(items.map((i) => ({ ...i, quantity: String(i.quantity) })))
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const term = search.trim().toLowerCase()
  const matches = term
    ? services.filter((s) => s.code.toLowerCase().includes(term) || s.name.toLowerCase().includes(term)).slice(0, 8)
    : []

  function add(s: PackageServiceOption) {
    setSaved(false)
    if (s.id === packageServiceId) { setError('A package cannot include itself'); return }
    if (s.category === 'package') { setError(`${s.code} is a package; packages cannot be nested`); return }
    if (rows.some((r) => r.itemServiceId === s.id)) { setError(`${s.code} is already in this package`); return }
    setError(null)
    setRows([...rows, { itemServiceId: s.id, code: s.code, name: s.name, quantity: '1' }])
  }

  async function save() {
    setSaved(false)
    const parsed = packageItemsSchema.safeParse({
      items: rows.map((r) => ({ serviceId: r.itemServiceId, quantity: /^\d+$/.test(r.quantity) ? Number(r.quantity) : NaN })),
    })
    if (!parsed.success) { setError('Each quantity must be a whole number from 1 to 999'); return }
    setError(null)
    setBusy(true)
    const res = await sendJson(`/api/tariff/packages/${packageServiceId}/items`, 'PUT', parsed.data)
    setBusy(false)
    if (res.ok) { setSaved(true); router.refresh(); return }
    setError(res.error)
  }

  return (
    <section aria-labelledby={`${uid}-h`} className="space-y-3">
      <h3 id={`${uid}-h`} className="text-base font-semibold">Package items</h3>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">No items yet. Search below to add services to this package.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => (
            <li key={r.itemServiceId} className="flex flex-wrap items-center gap-3 p-3">
              <span className="font-mono text-xs">{r.code}</span>
              <span className="flex-1 text-sm">{r.name}</span>
              <input
                aria-label={`Quantity of ${r.code}`} inputMode="numeric" value={r.quantity} className={`${FIELD_CLASS} w-20`}
                onChange={(e) => { setSaved(false); setRows(rows.map((x) => (x.itemServiceId === r.itemServiceId ? { ...x, quantity: e.target.value } : x))) }}
              />
              <Button variant="outline" size="sm" aria-label={`Remove ${r.code}`} onClick={() => { setSaved(false); setRows(rows.filter((x) => x.itemServiceId !== r.itemServiceId)) }}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <div>
        <label htmlFor={`${uid}-s`} className="mb-1 block text-xs font-medium text-muted-foreground">Search services to add</label>
        <input id={`${uid}-s`} type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Code or name" className={FIELD_CLASS} />
        {term && (
          matches.length === 0
            ? <p className="mt-2 text-sm text-muted-foreground">No matching services.</p>
            : (
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
                {matches.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 p-2 text-sm">
                    <span className="font-mono text-xs">{s.code}</span>
                    <span className="flex-1">{s.name}</span>
                    <Button variant="outline" size="sm" aria-label={`Add ${s.code}`} onClick={() => add(s)}>Add</Button>
                  </li>
                ))}
              </ul>
            )
        )}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {saved && <p role="status" className="text-sm text-muted-foreground">Package items saved.</p>}
      <Button onClick={() => void save()} disabled={busy}>Save package items</Button>
    </section>
  )
}
