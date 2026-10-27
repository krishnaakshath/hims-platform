'use client'
// WS1 T4: the plan at the end of the visit. Advice is part of the consultation record (PUT
// /api/encounters/[id]/consult); a follow-up is planned through the existing POST /api/follow-ups
// with originatingEncounterId (the route records it with source 'encounter'), prescribed by the
// visit's doctor.
import { useState } from 'react'
import { sendJson } from '@/lib/client-fetch'

type Unit = 'days' | 'weeks' | 'months'
const FIELD = 'mt-1 rounded-md border border-border px-2 py-1.5 text-sm text-foreground'

export function FollowUpAdvice({ encounterId, patientId, providerId, initialAdvice, readOnly = false }: {
  encounterId: number
  patientId: string
  providerId: number
  initialAdvice: string | null
  readOnly?: boolean
}) {
  const [advice, setAdvice] = useState(initialAdvice ?? '')
  const [adviceState, setAdviceState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [value, setValue] = useState('7')
  const [unit, setUnit] = useState<Unit>('days')
  const [reason, setReason] = useState('Review')
  const [followUpState, setFollowUpState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function saveAdvice() {
    setError(null)
    setAdviceState('saving')
    const trimmed = advice.trim()
    const res = await sendJson(`/api/encounters/${encounterId}/consult`, 'PUT', { advice: trimmed === '' ? null : trimmed })
    if (!res.ok) { setAdviceState('idle'); setError(res.error); return }
    setAdviceState('saved')
  }

  async function planFollowUp() {
    setError(null)
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > 365) { setError('Enter a follow-up interval between 1 and 365.'); return }
    if (!reason.trim()) { setError('Enter a reason for the follow-up.'); return }
    setFollowUpState('saving')
    const res = await sendJson('/api/follow-ups', 'POST', {
      patientId,
      originatingEncounterId: encounterId,
      prescribedByProviderId: providerId,
      timing: { kind: 'interval', interval: { value: n, unit } },
      reason: reason.trim(),
    })
    if (!res.ok) { setFollowUpState('idle'); setError(res.error); return }
    setFollowUpState('saved')
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-muted-foreground">Advice
          <textarea value={advice} readOnly={readOnly} maxLength={4000} rows={3}
            onChange={(e) => { setAdvice(e.target.value); if (adviceState === 'saved') setAdviceState('idle') }}
            className={`${FIELD} w-full`} />
        </label>
        {!readOnly && (
          <div className="mt-1 flex items-center gap-3">
            <button type="button" onClick={() => void saveAdvice()} disabled={adviceState === 'saving'}
              className="rounded-md border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-50">Save advice</button>
            {adviceState === 'saved' && <span role="status" className="text-xs text-success">Advice saved</span>}
          </div>
        )}
      </div>
      {!readOnly && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-muted-foreground">Follow up in
            <input type="number" min={1} max={365} value={value} onChange={(e) => setValue(e.target.value)} className={`${FIELD} block w-20`} />
          </label>
          <label className="text-xs font-medium text-muted-foreground">Unit
            <select value={unit} onChange={(e) => setUnit(e.target.value as Unit)} className={`${FIELD} block`}>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
              <option value="months">Months</option>
            </select>
          </label>
          <label className="min-w-48 flex-1 text-xs font-medium text-muted-foreground">Reason
            <input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} className={`${FIELD} block w-full`} />
          </label>
          <button type="button" onClick={() => void planFollowUp()} disabled={followUpState === 'saving'}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground disabled:opacity-50">Plan follow-up</button>
          {followUpState === 'saved' && <span role="status" className="text-xs text-success">Follow-up planned</span>}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
