import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getBroadcast } from '@/lib/queries/broadcasts'

export default async function BroadcastDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }. Must
  // precede notFound() below, not follow it.
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const { id } = await params
  const broadcast = await getBroadcast(Number(id))
  if (!broadcast) notFound()
  await logAudit(session, `viewed broadcast ${id}`, null)

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-foreground">{broadcast.subject || 'Broadcast'}</h1>
      <p className="mb-6 text-sm text-muted-foreground">{new Date(broadcast.sentAt).toLocaleString()} · {broadcast.trialCondition ?? 'All trials'} · Sent by {broadcast.sentBy}</p>
      <div className="mb-6 rounded-lg border border-border bg-card p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</p>
        <p className="mt-1 text-sm text-foreground">{broadcast.message}</p>
      </div>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients ({broadcast.recipientCount})</h2>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Patient</th>
            <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivery Status</th>
          </tr>
        </thead>
        <tbody>
          {broadcast.recipients.map((r, i) => (
            <tr key={r.patientId} className={`border-b border-border ${i % 2 === 1 ? 'bg-muted/40' : ''}`}>
              <td className="p-3"><Link href={`/patients/${r.patientId}`} className="font-medium text-primary hover:underline">{r.patientName}</Link></td>
              <td className="p-3">
                <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${r.deliveryStatus === 'delivered' ? 'text-emerald-800' : 'text-red-800'}`}>
                  <span className={`h-2 w-2 rounded-full ${r.deliveryStatus === 'delivered' ? 'bg-emerald-600' : 'bg-red-600'}`} aria-hidden="true" />
                  {r.deliveryStatus === 'delivered' ? 'Delivered' : 'Failed'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
