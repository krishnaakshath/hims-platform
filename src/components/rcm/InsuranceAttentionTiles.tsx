// WS12 R15: the three insurance attention tiles on /rcm. Patients are shown by UHID.
import Link from 'next/link'
import type { InsuranceAttention } from '@/lib/queries/coverage-attention'

const tile = 'rounded-lg border border-border bg-card p-4 text-sm'

export function InsuranceAttentionTiles({ data, canEditSettings }: { data: InsuranceAttention; canEditSettings: boolean }) {
  const { policiesExpiringIn7Days: expiring, admissionsTodayUnverified: unverified, claimsBlockedByIdentifiers: blocked } = data
  return (
    <section aria-label="Insurance attention" className="grid gap-3 sm:grid-cols-3">
      <div className={tile}>
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">Policies expiring in 7 days</h2>
        <p className="mt-1 text-2xl font-bold">{expiring}</p>
        {expiring > 0 && <Link href="/rcm/policies?expiring=7" className="text-primary hover:underline">View policies</Link>}
      </div>
      <div className={tile}>
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">Admitted today, cover not verified</h2>
        <p className="mt-1 text-2xl font-bold">{unverified.length}</p>
        {unverified.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {unverified.slice(0, 5).map((a) => (
              <li key={a.admissionId}><Link href={`/patients/${encodeURIComponent(a.patientId)}`} className="text-primary hover:underline">{a.uhid ?? '—'}</Link> · {a.payerName}</li>
            ))}
            {unverified.length > 5 && <li className="text-muted-foreground">and {unverified.length - 5} more</li>}
          </ul>
        )}
      </div>
      <div className={tile}>
        <h2 className="text-xs font-semibold uppercase text-muted-foreground">Claims blocked by hospital identifiers</h2>
        <p className="mt-1 text-2xl font-bold">{blocked}</p>
        {blocked > 0 && (canEditSettings
          ? <Link href="/rcm/settings" className="text-primary hover:underline">Set them in RCM settings</Link>
          : <p className="text-muted-foreground">Ask an administrator to set the ROHINI and HFR IDs.</p>)}
      </div>
    </section>
  )
}
