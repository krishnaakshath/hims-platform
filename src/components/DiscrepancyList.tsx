'use client'
import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { sendJson } from '@/lib/client-fetch'

export interface DiscrepancyRow {
  id: number
  questionLabel: string
  patientAnswer: string
  chartFinding: string
  resolved: boolean
  resolvedBy: string | null
  createdAt: string
}

export function DiscrepancyList({ discrepancies }: { discrepancies: DiscrepancyRow[] }) {
  const [resolvingId, setResolvingId] = useState<number | null>(null)

  const open = discrepancies.filter((d) => !d.resolved)
  const resolved = discrepancies.filter((d) => d.resolved)

  const [error, setError] = useState<string | null>(null)

  async function resolve(id: number) {
    setResolvingId(id)
    setError(null)
    const result = await sendJson(`/api/discrepancies/${id}/resolve`, 'POST')
    if (!result.ok) { setError(result.error); setResolvingId(null); return }
    // A full reload rather than router.refresh() -- this page's data comes
    // from a Redis-cached query (getPatientDetail), and the freshly
    // invalidated cache only reliably shows up on a real navigation, not a
    // soft RSC refresh, in local testing against this app's dev server.
    window.location.reload()
  }

  if (discrepancies.length === 0) {
    return <p className="text-sm text-muted-foreground">No discrepancies found between this patient&apos;s form answers and their chart.</p>
  }

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {open.map((d) => (
        <div key={d.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-700" aria-hidden="true" />
            <span className="text-sm font-semibold text-foreground">{d.questionLabel}</span>
          </div>
          <p className="text-sm text-foreground">Patient said: <span className="font-medium">{d.patientAnswer}</span></p>
          <p className="text-sm text-foreground">Chart shows: <span className="font-medium">{d.chartFinding}</span></p>
          <button
            onClick={() => resolve(d.id)}
            disabled={resolvingId === d.id}
            className="mt-3 rounded-md border border-amber-500/40 bg-card px-3 py-1 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-500/10 disabled:opacity-50"
          >
            {resolvingId === d.id ? 'Marking resolved…' : 'Mark resolved'}
          </button>
        </div>
      ))}
      {resolved.length > 0 && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer font-medium">{resolved.length} resolved</summary>
          <div className="mt-2 space-y-2">
            {resolved.map((d) => (
              <div key={d.id} className="rounded-lg border border-border p-3 text-xs">
                <p className="font-medium text-foreground">{d.questionLabel}</p>
                <p>Patient said: {d.patientAnswer} · Chart: {d.chartFinding}</p>
                <p className="text-muted-foreground">Resolved by {d.resolvedBy}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
