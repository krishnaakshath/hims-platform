'use client'
// SP5: release the PDF report of one requisition (LAB_REPORT_RELEASE_ROLES). The parent shows
// the outcome, because the group this button sits in leaves "To report" after the refresh.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { sendJson } from '@/lib/client-fetch'

export type LabFollowUpOutcome = 'not_requested' | 'pending' | 'created' | 'linked' | 'failed' | 'already_resolved'
export interface ReleasedReport {
  report: { id: number; reportNumber: string; version: number }
  followUp: { outcome: LabFollowUpOutcome; followUpOrderId: number | null; dueDate: string | null }
}

export function ReleaseReportButton({ requisitionId, onReleased }: { requisitionId: number; onReleased: (r: ReleasedReport) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function release() {
    setBusy(true)
    setError(null)
    const res = await sendJson<ReleasedReport>(`/api/lab-requisitions/${requisitionId}/report`, 'POST')
    setBusy(false)
    if (res.ok && res.data) { onReleased(res.data); return }
    setError(res.ok ? 'The report was released, but the response was empty. Refresh to see it.' : res.error)
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="xs" onClick={release} disabled={busy}>{busy ? 'Releasing…' : 'Release report'}</Button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  )
}
