'use client'
import { useEffect, useState } from 'react'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { formatPaise } from '@/lib/format'
import type { EstimateLine } from '@/lib/rcm/snapshot'
import { PRICE_SOURCE_LABEL } from '@/lib/rcm/constants'
import { inputClass, secondaryButtonClass } from './ui'

export interface EstimateItem { serviceId: number; code: string; name: string; quantity: number }

/** Service rows with quantities; every change is priced by POST /api/rcm/preauths/estimate (debounced 300 ms). */
export function EstimateTable({ policyId, plannedAdmissionDate, roomCategoryCode, items, onItems, onTotal }: {
  policyId: number | null; plannedAdmissionDate: string; roomCategoryCode: string; items: EstimateItem[]; onItems: (i: EstimateItem[]) => void; onTotal: (paise: number | null) => void
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<{ id: number; code: string; name: string }[]>([])
  const [lines, setLines] = useState<EstimateLine[]>([])
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(async () => {
      if (policyId === null || items.length === 0 || !plannedAdmissionDate) { setLines([]); setProblem(null); onTotal(null); return }
      const r = await sendJson<{ lines: EstimateLine[]; totalPaise: number }>('/api/rcm/preauths/estimate', 'POST', {
        policyId, plannedAdmissionDate, estimate: items.map((i) => ({ serviceId: i.serviceId, quantity: i.quantity })), ...(roomCategoryCode ? { roomCategoryCode } : {}),
      })
      if (r.ok) { setLines(r.data.lines); setProblem(null); onTotal(r.data.totalPaise) } else { setLines([]); setProblem(r.error); onTotal(null) }
    }, 300)
    return () => clearTimeout(t)
  }, [policyId, plannedAdmissionDate, roomCategoryCode, items, onTotal])

  async function search() {
    if (q.trim().length < 2) return
    const r = await fetchJson<{ services: { id: number; code: string; name: string }[] }>(`/api/tariff/services?q=${encodeURIComponent(q.trim())}`)
    setHits(r.ok ? r.data.services.slice(0, 10) : [])
  }

  const priced = new Map(lines.map((l) => [l.serviceId, l]))
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input className={inputClass} placeholder="Search services" aria-label="Search services" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search() } }} />
        <button type="button" className={secondaryButtonClass} onClick={() => void search()}>Search</button>
      </div>
      {hits.length > 0 && (
        <ul className="rounded-md border border-border text-sm">
          {hits.map((h) => (
            <li key={h.id}><button type="button" className="w-full px-2 py-1 text-left hover:bg-muted" onClick={() => { if (!items.some((i) => i.serviceId === h.id)) onItems([...items, { serviceId: h.id, code: h.code, name: h.name, quantity: 1 }]); setHits([]); setQ('') }}>{h.code} · {h.name}</button></li>
          ))}
        </ul>
      )}
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground"><tr><th>Service</th><th>Qty</th><th>Price source</th><th className="text-right">Amount</th><th /></tr></thead>
        <tbody>
          {items.map((i) => {
            const l = priced.get(i.serviceId)
            return (
              <tr key={i.serviceId} className="border-t border-border">
                <td>{i.code} · {i.name}</td>
                <td><input type="number" min={1} max={1000} aria-label={`Quantity of ${i.code}`} className={`${inputClass} w-20`} value={i.quantity}
                  onChange={(e) => onItems(items.map((x) => (x.serviceId === i.serviceId ? { ...x, quantity: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) } : x)))} /></td>
                <td>{l ? PRICE_SOURCE_LABEL[l.priceSource] ?? l.priceSource : '—'}</td>
                <td className="text-right tabular-nums">{l ? formatPaise(l.amountPaise) : '—'}</td>
                <td><button type="button" className={secondaryButtonClass} onClick={() => onItems(items.filter((x) => x.serviceId !== i.serviceId))}>Remove</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {problem && <p role="alert" className="text-xs text-destructive">{problem}</p>}
      {lines.length > 0 && <p className="text-right text-sm font-semibold">Estimate {formatPaise(lines.reduce((a, l) => a + l.amountPaise, 0))}</p>}
    </div>
  )
}
