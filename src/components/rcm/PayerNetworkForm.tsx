'use client'
import { useState } from 'react'
import { useRcmAction } from './useRcmAction'
import { FormError, Panel, buttonClass } from './ui'

export function PayerNetworkForm({ payerId, tpas, selected }: { payerId: number; tpas: { payerId: number; name: string }[]; selected: number[] }) {
  const [ids, setIds] = useState<number[]>(selected)
  const run = useRcmAction()
  return (
    <Panel title="TPAs that service this insurer">
      {tpas.length === 0 ? <p className="text-sm text-muted-foreground">No TPA profiles yet.</p> : (
        <ul className="grid gap-1 text-sm sm:grid-cols-2">
          {tpas.map((t) => <li key={t.payerId}><label className="flex items-center gap-2"><input type="checkbox" checked={ids.includes(t.payerId)} onChange={(e) => setIds((x) => (e.target.checked ? [...x, t.payerId] : x.filter((i) => i !== t.payerId)))} />{t.name}</label></li>)}
        </ul>
      )}
      <button type="button" className={`${buttonClass} mt-2`} disabled={run.busy} onClick={() => run.send(`/api/rcm/payers/${payerId}/networks`, 'PUT', { tpaPayerIds: ids })}>Save network</button>
      <FormError error={run.error} />
    </Panel>
  )
}
