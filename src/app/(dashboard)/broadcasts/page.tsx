import { formatIstDate } from '@/lib/india-time'
import Link from 'next/link'
import { demoFeaturesEnabled } from '@/lib/demo-features'
import { notFound, redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listBroadcasts, listBroadcastFilterOptions } from '@/lib/queries/broadcasts'
import { trialsEnabled } from '@/lib/features'
import { listAllTrials } from '@/lib/queries/trials'
import { BroadcastWizard } from '@/components/BroadcastWizard'
import { DemoBadge } from '@/components/DemoBadge'
import { EmptyState } from '@/components/ui/empty-state' // WS7 T16

export default async function BroadcastsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const session = await requireSessionOrRedirect()
  // LeftNav.tsx:62 — { href: '/broadcasts', roles: ['admin', 'crc'] }
  if (!['admin', 'crc'].includes(session.role)) redirect('/')
  // Wave B P1-21: demo-only page -- 404 unless DEMO_FEATURES is on (after the role gate, before any read).
  if (!demoFeaturesEnabled()) notFound()
  const { tab } = await searchParams
  const activeTab = tab === 'history' ? 'history' : 'send'
  await logAudit(session, `viewed broadcasts (${activeTab})`, null)

  const trialsOn = trialsEnabled()
  const trials = trialsOn ? await listAllTrials() : []
  const broadcasts = activeTab === 'history' ? await listBroadcasts() : []
  const options = activeTab === 'send' ? await listBroadcastFilterOptions() : { departments: [], providers: [], wards: [] }

  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-foreground">Patient Broadcast<DemoBadge /></h1>
      <p className="mb-6 text-sm text-muted-foreground">Messages go out through the hospital&apos;s notification channels. Opted-out patients are never contacted.</p>
      <div className="mb-6 flex w-fit gap-1 rounded-lg bg-secondary p-1 text-sm">
        <Link href="/broadcasts?tab=send" className={`rounded-md px-4 py-1.5 font-medium transition-colors ${activeTab === 'send' ? 'bg-card text-primary shadow-none' : 'text-muted-foreground hover:text-foreground'}`}>Send Broadcast</Link>
        <Link href="/broadcasts?tab=history" className={`rounded-md px-4 py-1.5 font-medium transition-colors ${activeTab === 'history' ? 'bg-card text-primary shadow-none' : 'text-muted-foreground hover:text-foreground'}`}>Broadcast History</Link>
      </div>

      {activeTab === 'send' ? (
        <BroadcastWizard trials={trials.map((t) => ({ id: t.id, condition: t.condition }))} showTrialFilters={trialsOn} departments={options.departments} providers={options.providers} wards={options.wards} />
      ) : broadcasts.length === 0 ? (
        <EmptyState title="No broadcasts sent yet" action={{ label: 'Send a broadcast', href: '/broadcasts?tab=send' }} />
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-card shadow-none">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left">
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Channel</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Message</th>
                {trialsOn && <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Trial</th>}
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recipients</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Skipped</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Not Delivered</th>
                <th className="p-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sent By</th>
              </tr>
            </thead>
            <tbody>
              {broadcasts.map((b, i) => {
                // WS7 T10: real sends store counts; older simulated rows derive them from the snapshot.
                const delivered = b.templateKey ? b.sentCount : b.recipients.filter((r) => r.deliveryStatus === 'delivered').length
                const failed = b.templateKey ? b.failedCount : b.recipients.length - delivered
                const skipped = b.templateKey ? b.skippedCount : 0
                return (
                  <tr key={b.id} className={`border-b border-border last:border-b-0 ${i % 2 === 1 ? 'bg-muted/40' : ''} transition-colors hover:bg-secondary`}>
                    <td className="p-3 text-muted-foreground">{formatIstDate(b.sentAt)}</td>
                    <td className="p-3 text-foreground">{b.templateKey ? 'Notice' : b.channel === 'both' ? 'SMS + Email' : b.channel === 'sms' ? 'SMS' : 'Email'}</td>
                    <td className="p-3"><Link href={`/broadcasts/${b.id}`} className="font-medium text-primary hover:underline">{b.message.length > 60 ? `${b.message.slice(0, 60)}…` : b.message}</Link></td>
                    {trialsOn && <td className="p-3 text-foreground">{b.trialCondition ?? 'All trials'}</td>}
                    <td className="p-3 text-foreground">{b.recipientCount}</td>
                    <td className="p-3 text-success">{delivered}</td>
                    <td className="p-3 text-muted-foreground">{skipped}</td>
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
