import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ABDM_SHARE_QUEUE_ROLES } from '@/lib/role-policy'
import { listPendingShares, scanShareSetup } from '@/lib/queries/abdm-profile-shares'
import { ProfileShareQueue } from '@/components/abdm/ProfileShareQueue'

// ABHA Scan & Share registration queue (SP8 Task 6): patients who scanned the
// desk QR code, by token number. ABHA numbers are masked here.
export default async function AbdmSharesPage() {
  const session = await requireSessionOrRedirect()
  if (!ABDM_SHARE_QUEUE_ROLES.includes(session.role)) redirect('/')

  const setup = scanShareSetup()
  const rows = await listPendingShares()
  await logAudit(session, 'abdm: viewed profile share queue', null)
  return (
    <div>
      <h1 className="mb-1 text-2xl font-bold text-foreground">ABHA Scan &amp; Share</h1>
      <p className="mb-4 text-sm text-muted-foreground">Patients who shared their ABHA profile by scanning the desk QR code, by token number. Shares not handled within 24 hours are cleared.</p>
      {setup.state === 'not_configured' && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">Scan &amp; Share is not configured: no ABDM connection, HFR ID or gateway key set (see docs/ABDM-NHCX.md).</p>
      )}
      {setup.qrUrlTemplate && (
        <p className="mb-4 text-xs text-muted-foreground">Desk QR code link (one counter id per desk): <span className="font-mono break-all">{setup.qrUrlTemplate}</span></p>
      )}
      <ProfileShareQueue rows={rows} />
    </div>
  )
}
