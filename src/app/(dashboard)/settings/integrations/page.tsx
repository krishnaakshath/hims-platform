import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { formatIstDate, formatIstDateTime } from '@/lib/india-time'
import { INTEGRATION_SETTINGS_ROLES } from '@/lib/role-policy'
import { integrationOverview, type CertView } from '@/lib/integrations/overview'
import { recentExchanges } from '@/lib/queries/nhcx-review'
import { IntegrationStatusCard } from '@/components/settings/IntegrationStatusCard'
import { IntegrationTestButton } from '@/components/settings/IntegrationTestButton'

// /settings/integrations: the ABDM / NHCX connection (INTEGRATION_SETTINGS_ROLES, admin).
// Presence, names of missing variables, certificate subject / fingerprint / expiry only.
function Cert({ title, cert }: { title: string; cert: CertView }) {
  if (!cert) return <p className="text-xs text-muted-foreground">{title}: not loaded</p>
  const tone = cert.warning === 'expired' ? 'text-red-700' : cert.warning === 'expiring' ? 'text-amber-800' : 'text-foreground'
  return (
    <div className="text-xs">
      <p className="font-medium">{title}</p>
      <p>Subject <span className="font-mono">{cert.subject}</span> · fingerprint <span className="font-mono">{cert.fingerprintPrefix}</span></p>
      <p className={tone}>Valid to {formatIstDate(cert.validTo)} · {cert.expired ? 'expired' : `${cert.daysLeft} days left`}{cert.warning === 'expiring' ? ' · renew soon' : ''}</p>
    </div>
  )
}

export default async function IntegrationsPage() {
  const session = await requireSessionOrRedirect()
  if (!INTEGRATION_SETTINGS_ROLES.includes(session.role)) redirect('/')
  const o = integrationOverview()
  const recent = await recentExchanges(10)
  await logAudit(session, 'viewed ABDM / NHCX connection', null)
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">ABDM / NHCX connection</h1>
        <p className="text-sm text-muted-foreground">Credentials are set as environment variables (see docs/ABDM-NHCX.md); this page never shows them.{o.mode ? ` Mode: ${o.mode}.` : ''}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">{o.capabilities.map((c) => <IntegrationStatusCard key={c.key} status={c} />)}</div>
      <section className="space-y-3 rounded-md border border-border bg-card p-4">
        <h2 className="text-sm font-semibold">NHCX</h2>
        <p className="text-xs">Participant code: <span className="font-mono">{o.participantCode ?? 'not set'}</span></p>
        <Cert title="Our encryption certificate" cert={o.encryptionCert} />
        <Cert title="NHCX signing certificate" cert={o.signingCert} />
        {o.rotationInProgress && <p className="text-xs text-amber-800">Rotation in progress: the previous private key is still loaded.</p>}
        <p className="text-xs">Callback URL to register with NHCX: <span className="font-mono">{o.callbackUrl}</span></p>
        <p className="text-xs">ABDM bridge URL: <span className="font-mono">{o.bridgeUrl}</span></p>
        <div className="flex flex-wrap gap-4">
          <IntegrationTestButton capability="abdm" label="Test ABDM connection" />
          <IntegrationTestButton capability="nhcx" label="Test NHCX connection" />
        </div>
      </section>
      <section className="rounded-md border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-semibold">Recent NHCX exchanges</h2>
        {recent.length === 0 ? <p className="text-xs text-muted-foreground">None yet.</p> : (
          <table className="w-full text-xs"><tbody>{recent.map((r) => (
            <tr key={r.id} className="border-t border-border"><td className="py-1">#{r.id}</td><td>{r.direction}</td><td>{r.action}</td><td>{r.state}</td><td>{formatIstDateTime(r.createdAt)}</td><td>{r.isMock ? 'Sandbox mock - not real' : ''}</td></tr>
          ))}</tbody></table>
        )}
      </section>
    </div>
  )
}
