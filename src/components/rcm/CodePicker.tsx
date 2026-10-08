'use client'
import { useState } from 'react'
import { fetchJson } from '@/lib/client-fetch'
import { inputClass, secondaryButtonClass } from './ui'

export interface PickedCode { id: number; code: string; display: string }

/** Searches GET /api/coding/codes for one kind and keeps a list of picked codes. */
export function CodePicker({ kinds, label, value, onChange, max = 10 }: { kinds: readonly string[]; label: string; value: PickedCode[]; onChange: (v: PickedCode[]) => void; max?: number }) {
  const [kind, setKind] = useState(kinds[0])
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<PickedCode[]>([])
  const [note, setNote] = useState<string | null>(null)
  async function search() {
    if (!q.trim()) return
    const r = await fetchJson<{ codeSystem: unknown; hits: PickedCode[] }>(`/api/coding/codes?kind=${kind}&q=${encodeURIComponent(q.trim())}&limit=10`)
    if (!r.ok) { setNote(r.error); setHits([]); return }
    setNote(r.data.codeSystem === null ? 'No code set is loaded for this kind' : r.data.hits.length === 0 ? 'No matching code' : null)
    setHits(r.data.hits)
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        {kinds.length > 1 && <select className={`${inputClass} w-32`} aria-label={`${label} code set`} value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k} value={k}>{k.toUpperCase()}</option>)}</select>}
        <input className={inputClass} aria-label={`Search ${label}`} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search() } }} />
        <button type="button" className={secondaryButtonClass} onClick={() => void search()}>Find</button>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {hits.length > 0 && <ul className="rounded-md border border-border text-sm">{hits.map((h) => <li key={h.id}><button type="button" className="w-full px-2 py-1 text-left hover:bg-muted" onClick={() => { if (value.length < max && !value.some((v) => v.id === h.id)) onChange([...value, h]); setHits([]); setQ('') }}>{h.code} · {h.display}</button></li>)}</ul>}
      <ul className="flex flex-wrap gap-1">{value.map((v) => <li key={v.id} className="rounded bg-muted px-2 py-0.5 text-xs">{v.code} {v.display} <button type="button" aria-label={`Remove ${v.code}`} onClick={() => onChange(value.filter((x) => x.id !== v.id))}>×</button></li>)}</ul>
    </div>
  )
}
