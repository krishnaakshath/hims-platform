'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { formatPaise } from '@/lib/money'
import { SERVICE_CATEGORIES, type ServiceCategory } from '@/lib/tariff/validation'
import { ConfirmDialog } from './ConfirmDialog'
import { ServiceFormModal, type DepartmentOption } from './ServiceFormModal'
import { FIELD_CLASS, sendJson } from './api'

export interface ServiceListItem {
  id: number
  code: string
  name: string
  departmentId: number
  departmentName: string
  category: ServiceCategory
  hsnSac: string
  gstRateBp: number
  isActive: boolean
  basePaise: number | null
  departmentPaise: number | null
}

export interface ServiceFilters { q?: string; departmentId?: string; category?: string; inactive?: string }

const CATEGORY_LABEL = new Map<string, string>(SERVICE_CATEGORIES.map((c) => [c.code, c.label]))
const TH = 'p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground'

const money = (paise: number | null) => (paise === null ? '—' : formatPaise(paise))

export function ServicesTable({ services, departments, filters }: { services: ServiceListItem[]; departments: DepartmentOption[]; filters: ServiceFilters }) {
  const router = useRouter()
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; service: ServiceListItem } | null>(null)
  const [deactivating, setDeactivating] = useState<ServiceListItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirmDeactivate() {
    if (!deactivating) return
    setBusy(true)
    setError(null)
    const res = await sendJson(`/api/tariff/services/${deactivating.id}`, 'PATCH', { isActive: false })
    setBusy(false)
    if (res.ok) { setDeactivating(null); router.refresh(); return }
    setError(res.error)
  }

  const deptView = Boolean(filters.departmentId)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <form method="get" role="search" aria-label="Filter services" className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="svc-q" className="mb-1 block text-xs font-medium text-muted-foreground">Search</label>
            <input id="svc-q" name="q" type="search" defaultValue={filters.q ?? ''} placeholder="Code or name" className={`${FIELD_CLASS} w-48`} />
          </div>
          <div>
            <label htmlFor="svc-dept" className="mb-1 block text-xs font-medium text-muted-foreground">Department</label>
            <select id="svc-dept" name="departmentId" defaultValue={filters.departmentId ?? ''} className={`${FIELD_CLASS} w-48`}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="svc-cat" className="mb-1 block text-xs font-medium text-muted-foreground">Category</label>
            <select id="svc-cat" name="category" defaultValue={filters.category ?? ''} className={`${FIELD_CLASS} w-48`}>
              <option value="">All categories</option>
              {SERVICE_CATEGORIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="inactive" value="1" defaultChecked={filters.inactive === '1'} /> Show inactive
          </label>
          <Button type="submit" variant="outline">Apply filters</Button>
        </form>
        <div className="flex flex-wrap gap-2">
          <Link href="/tariffs/room-categories" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Room categories</Link>
          <Link href="/tariffs/import" className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Import CSV</Link>
          <Button onClick={() => setModal({ mode: 'create' })}>New service</Button>
        </div>
      </div>

      {deptView && (
        <p className="text-sm text-muted-foreground">Department price list view: the Department price column shows each service&apos;s current price in the selected department.</p>
      )}

      {services.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No services match these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Service catalogue</caption>
            <thead>
              <tr className="border-b border-border bg-secondary/40">
                <th scope="col" className={TH}>Code</th>
                <th scope="col" className={TH}>Name</th>
                <th scope="col" className={TH}>Department</th>
                <th scope="col" className={TH}>Category</th>
                <th scope="col" className={TH}>HSN/SAC</th>
                <th scope="col" className={`${TH} text-right`}>GST %</th>
                <th scope="col" className={`${TH} text-right`}>Base price</th>
                <th scope="col" className={`${TH} text-right`}>Department price</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={TH}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} className="border-b border-border last:border-b-0 hover:bg-secondary">
                  <td className="whitespace-nowrap p-3 font-mono text-xs">{s.code}</td>
                  <td className="p-3 font-medium"><Link href={`/tariffs/services/${s.id}`} className="text-primary underline-offset-2 hover:underline">{s.name}</Link></td>
                  <td className="p-3">{s.departmentName}</td>
                  <td className="p-3">{CATEGORY_LABEL.get(s.category) ?? s.category}</td>
                  <td className="p-3 font-mono text-xs">{s.hsnSac}</td>
                  <td className="p-3 text-right">{s.gstRateBp / 100}%</td>
                  <td className="whitespace-nowrap p-3 text-right">{money(s.basePaise)}</td>
                  <td className="whitespace-nowrap p-3 text-right">{money(s.departmentPaise)}</td>
                  <td className="p-3">{s.isActive ? 'Active' : 'Inactive'}</td>
                  <td className="whitespace-nowrap p-3 text-right">
                    <Button variant="outline" size="sm" aria-label={`Edit ${s.code}`} onClick={() => setModal({ mode: 'edit', service: s })}>Edit</Button>
                    {s.isActive && (
                      <Button variant="outline" size="sm" className="ml-2" aria-label={`Deactivate ${s.code}`} onClick={() => { setError(null); setDeactivating(s) }}>Deactivate</Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal?.mode === 'create' && <ServiceFormModal mode="create" departments={departments} onClose={() => setModal(null)} />}
      {modal?.mode === 'edit' && (
        <ServiceFormModal
          mode="edit"
          departments={departments}
          service={{ id: modal.service.id, code: modal.service.code, name: modal.service.name, departmentId: modal.service.departmentId, category: modal.service.category, hsnSac: modal.service.hsnSac, gstRateBp: modal.service.gstRateBp }}
          onClose={() => setModal(null)}
        />
      )}
      {deactivating && (
        <ConfirmDialog
          title="Deactivate service"
          message={`Deactivate ${deactivating.code} (${deactivating.name})? It will stop appearing in price lookups and new orders. Existing rate history is kept.`}
          confirmLabel="Deactivate service"
          busy={busy}
          error={error}
          onConfirm={confirmDeactivate}
          onCancel={() => setDeactivating(null)}
        />
      )}
    </div>
  )
}
