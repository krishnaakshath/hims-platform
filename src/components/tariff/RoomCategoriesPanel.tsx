'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { roomCategoryCreateSchema } from '@/lib/tariff/validation'
import { ConfirmDialog } from './ConfirmDialog'
import { FIELD_CLASS, sendJson } from './api'

export interface RoomCategoryItem { id: number; code: string; name: string; isActive: boolean }
export interface RoomItem { id: number; ward: string; roomNumber: string; bedNumber: string; roomCategoryId: number | null }

const lbl = 'mb-1 block text-xs font-medium text-muted-foreground'

export function RoomCategoriesPanel({ categories, rooms }: { categories: RoomCategoryItem[]; rooms: RoomItem[] }) {
  const router = useRouter()
  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)
  const [deactivating, setDeactivating] = useState<RoomCategoryItem | null>(null)
  const [assigned, setAssigned] = useState<Record<number, number | null>>({})
  const [error, setError] = useState<string | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function createCategory() {
    setError(null)
    const parsed = roomCategoryCreateSchema.safeParse({ code: newCode, name: newName })
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? 'Check the code and name'); return }
    setBusy(true)
    const res = await sendJson('/api/tariff/room-categories', 'POST', parsed.data)
    setBusy(false)
    if (res.ok) { setNewCode(''); setNewName(''); router.refresh(); return }
    setError(res.error)
  }

  async function patchCategory(id: number, body: { name?: string; isActive?: boolean }, onOk: () => void, onError: (m: string) => void) {
    setBusy(true)
    const res = await sendJson(`/api/tariff/room-categories/${id}`, 'PATCH', body)
    setBusy(false)
    if (res.ok) { onOk(); router.refresh(); return }
    onError(res.error)
  }

  async function assignRoom(room: RoomItem, value: string) {
    setError(null)
    const roomCategoryId = value === '' ? null : Number(value)
    const before = room.id in assigned ? assigned[room.id] : room.roomCategoryId
    setAssigned((a) => ({ ...a, [room.id]: roomCategoryId }))
    const res = await sendJson(`/api/tariff/rooms/${room.id}/category`, 'PUT', { roomCategoryId })
    if (res.ok) { router.refresh(); return }
    setAssigned((a) => ({ ...a, [room.id]: before }))
    setError(res.error)
  }

  const wards = new Map<string, RoomItem[]>()
  for (const r of rooms) wards.set(r.ward, [...(wards.get(r.ward) ?? []), r])
  const active = categories.filter((c) => c.isActive)

  return (
    <div className="space-y-8">
      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}

      <section aria-labelledby="rc-h" className="space-y-3">
        <h2 id="rc-h" className="text-lg font-semibold">Room categories</h2>
        {categories.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No room categories yet. Add one below.</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {categories.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="w-28 font-mono text-xs">{c.code}</span>
                {renaming?.id === c.id ? (
                  <>
                    <input aria-label={`Name for ${c.code}`} value={renaming.name} maxLength={100} onChange={(e) => setRenaming({ id: c.id, name: e.target.value })} className={`${FIELD_CLASS} max-w-xs flex-1`} />
                    <Button size="sm" aria-label={`Save name for ${c.code}`} disabled={busy || !renaming.name.trim()} onClick={() => void patchCategory(c.id, { name: renaming.name.trim() }, () => setRenaming(null), setError)}>Save</Button>
                    <Button size="sm" variant="outline" onClick={() => setRenaming(null)}>Cancel</Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm">{c.name}{!c.isActive && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}</span>
                    <Button size="sm" variant="outline" aria-label={`Rename ${c.code}`} onClick={() => { setError(null); setRenaming({ id: c.id, name: c.name }) }}>Rename</Button>
                    {c.isActive ? (
                      <Button size="sm" variant="outline" aria-label={`Deactivate ${c.code}`} onClick={() => { setDialogError(null); setDeactivating(c) }}>Deactivate</Button>
                    ) : (
                      <Button size="sm" variant="outline" aria-label={`Activate ${c.code}`} disabled={busy} onClick={() => { setError(null); void patchCategory(c.id, { isActive: true }, () => undefined, setError) }}>Activate</Button>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-wrap items-end gap-2" noValidate onSubmit={(e) => { e.preventDefault(); void createCategory() }}>
          <div>
            <label htmlFor="rc-code" className={lbl}>New category code</label>
            <input id="rc-code" value={newCode} onChange={(e) => setNewCode(e.target.value)} maxLength={16} placeholder="e.g. DELUXE" className={`${FIELD_CLASS} w-40`} />
          </div>
          <div>
            <label htmlFor="rc-name" className={lbl}>New category name</label>
            <input id="rc-name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={100} placeholder="e.g. Deluxe Room" className={`${FIELD_CLASS} w-56`} />
          </div>
          <Button type="submit" disabled={busy}>Add category</Button>
        </form>
      </section>

      <section aria-labelledby="rooms-h" className="space-y-3">
        <h2 id="rooms-h" className="text-lg font-semibold">Rooms by ward</h2>
        {rooms.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">No rooms are set up yet.</p>
        ) : (
          [...wards].map(([ward, list]) => (
            <div key={ward} className="overflow-x-auto rounded-lg border border-border">
              <h3 className="bg-secondary/40 p-3 text-sm font-medium">{ward}</h3>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Room</th>
                    <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Bed</th>
                    <th scope="col" className="p-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Category</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => {
                    const current = r.id in assigned ? assigned[r.id] : r.roomCategoryId
                    const stale = current !== null && !active.some((c) => c.id === current) ? categories.find((c) => c.id === current) : undefined
                    return (
                      <tr key={r.id} className="border-b border-border last:border-b-0">
                        <td className="p-3">{r.roomNumber}</td>
                        <td className="p-3">{r.bedNumber}</td>
                        <td className="p-3">
                          <select
                            aria-label={`Category for ${r.ward} room ${r.roomNumber} bed ${r.bedNumber}`}
                            value={current === null ? '' : String(current)}
                            onChange={(e) => void assignRoom(r, e.target.value)}
                            className={`${FIELD_CLASS} max-w-xs`}
                          >
                            <option value="">None</option>
                            {stale && <option value={stale.id} disabled>{stale.name} (inactive)</option>}
                            {active.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
                          </select>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ))
        )}
      </section>

      {deactivating && (
        <ConfirmDialog
          title="Deactivate room category"
          message={`Deactivate ${deactivating.code} (${deactivating.name})? It can no longer be assigned to rooms. Existing rates keep their history.`}
          confirmLabel="Deactivate category"
          busy={busy}
          error={dialogError}
          onConfirm={() => void patchCategory(deactivating.id, { isActive: false }, () => setDeactivating(null), setDialogError)}
          onCancel={() => setDeactivating(null)}
        />
      )}
    </div>
  )
}
