import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listBroadcasts } from '@/lib/queries/broadcasts'
import { listAllTrials } from '@/lib/queries/trials'
import { BroadcastWizard } from '@/components/BroadcastWizard'

export default async function BroadcastsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  const { tab } = await searchParams
  const activeTab = tab === 'history' ? 'history' : 'send'
  await logAudit(session, `viewed broadcasts (${activeTab})`, null)

  const trials = await listAllTrials()
  const broadcasts = activeTab === 'history' ? await listBroadcasts() : []

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-foreground">Patient Broadcast</h1>
      <p className="mb-6 text-sm text-muted-foreground">Simulated delivery only — no SMS or email is ever sent to a real patient.</p>
      <div className="mb-6 flex w-fit gap-1 rounded-lg bg-secondary p-1 text-sm">
        <Link href="/broadcasts?tab=send" className={`rounded-md px-4 py-1.5 font-medium transition-colors ${activeTab === 'send' ? 'bg-card text-primary shadow-none' : 'text-muted-foreground hover:text-foreground'}`}>Send Broadcast</Link>
        <Link href="/broadcasts?tab=history" className={`rounded-md px-4 py-1.5 font-medium transition-colors ${activeTab === 'history' ? 'bg-card text-primary shadow-none' : 'text-muted-foreground hover:text-foreground'}`}>Broadcast History</Link>
      </div>

      {activeTab === 'send' ? (
        <BroadcastWizard trials={trials.map((t) => ({ id: t.id, condition: t.condition }))} />
      ) : broadcasts.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-8 text-center shadow-none">
          <p className="text-sm text-muted-foreground">No records found.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card shadow-none">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trial</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivered</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Failed</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent By</th>
              </tr>
            </thead>
            <tbody>
              {broadcasts.map((b, i) => {
                const delivered = b.recipients.filter((r) => r.deliveryStatus === 'delivered').length
                const failed = b.recipients.length - delivered
                return (
                  <tr key={b.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                    <td className="p-3 text-muted-foreground">{new Date(b.sentAt).toLocaleDateString()}</td>
                    <td className="p-3 text-foreground">{b.channel === 'both' ? 'SMS + Email' : b.channel === 'sms' ? 'SMS' : 'Email'}</td>
                    <td className="p-3"><Link href={`/broadcasts/${b.id}`} className="font-medium text-primary hover:underline">{b.message.length > 60 ? `${b.message.slice(0, 60)}…` : b.message}</Link></td>
                    <td className="p-3 text-foreground">{b.trialCondition ?? 'All trials'}</td>
                    <td className="p-3 text-foreground">{b.recipientCount}</td>
                    <td className="p-3 text-success">{delivered}</td>
                    <td className="p-3 text-destructive">{failed}</td>
                    <td className="p-3 text-muted-foreground">{b.sentBy}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
