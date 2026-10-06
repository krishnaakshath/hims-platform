'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ProviderDot } from './ProviderDot'

interface ProviderOption {
  id: number
  name: string
  colorTag: string
}

export function CalendarProviderFilter({ providers, selectedIds }: { providers: ProviderOption[]; selectedIds: number[] }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  // Always writes an explicit providerIds value, including an empty string
  // for "none selected" — the calendar page distinguishes "param absent"
  // (no filter, show all) from "param present but empty" (show none).
  function pushProviderIds(ids: number[]) {
    const params = new URLSearchParams(searchParams.toString())
    params.set('providerIds', ids.join(','))
    router.push(`${pathname}?${params.toString()}`)
  }

  function toggle(id: number) {
    const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
    pushProviderIds(next)
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Providers</h2>
        <div className="flex gap-2 text-xs">
          <button onClick={() => pushProviderIds(providers.map((p) => p.id))} className="font-medium text-primary hover:underline">Check All</button>
          <button onClick={() => pushProviderIds([])} className="font-medium text-primary hover:underline">Uncheck All</button>
        </div>
      </div>
      <ul className="space-y-1.5">
        {providers.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={selectedIds.includes(p.id)} onChange={() => toggle(p.id)} />
              <ProviderDot colorTag={p.colorTag} />
              {p.name}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}
