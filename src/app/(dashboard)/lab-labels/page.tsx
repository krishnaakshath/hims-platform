// SP5: printable sample label sheet, reached from the worklist / home-collection "Print label"
// links (no nav entry). Gate LAB_LABEL_ROLES, checked before any query.
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { LAB_LABEL_ROLES } from '@/lib/role-policy'
import { logAudit } from '@/lib/audit'
import { listLabelsForOrders } from '@/lib/queries/lab-orders'
import { SampleLabelSheet } from '@/components/labs/SampleLabelSheet'
import { PrintButton } from '@/components/PrintButton'

const MAX_LABELS = 50

/** Comma-separated positive int32 ids; invalid tokens are dropped, duplicates removed, max 50. */
function parseOrderIds(raw: string | string[] | undefined): number[] {
  if (typeof raw !== 'string') return []
  const ids: number[] = []
  for (const token of raw.split(',')) {
    const t = token.trim()
    if (!/^\d{1,10}$/.test(t)) continue
    const id = Number(t)
    if (id < 1 || id > 2_147_483_647 || ids.includes(id)) continue
    ids.push(id)
    if (ids.length === MAX_LABELS) break
  }
  return ids
}

export default async function LabLabelsPage({ searchParams }: { searchParams: Promise<{ orders?: string | string[] }> }) {
  const session = await requireSessionOrRedirect()
  if (!LAB_LABEL_ROLES.includes(session.role)) redirect('/')

  const ids = parseOrderIds((await searchParams).orders)
  if (ids.length === 0) {
    return <p className="text-sm text-muted-foreground">No orders selected.</p>
  }

  const labels = await listLabelsForOrders(ids)
  // Ids only: the labels carry names, which never go into the audit details.
  await logAudit(session, 'printed lab sample labels', null, `orders=${ids.join(',')}`)

  return (
    <div>
      <div className="no-print mb-4 flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-foreground">Sample labels</h1>
        <PrintButton />
      </div>
      {labels.length === 0
        ? <p className="text-sm text-muted-foreground">No orders selected.</p>
        : <SampleLabelSheet labels={labels} />}
    </div>
  )
}
