// WS12 R13: shown above every /rcm page while the hospital's ROHINI or HFR id is not set.
import Link from 'next/link'

const LABEL = { rohini: 'ROHINI ID', hfr: 'HFR facility ID' } as const

export function HospitalIdentifiersNotice({ missing, canEdit }: { missing: ('rohini' | 'hfr')[]; canEdit: boolean }) {
  if (missing.length === 0) return null
  const names = missing.map((m) => LABEL[m]).join(' and ')
  return (
    <div role="alert" className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
      <p>
        The hospital&apos;s {names} {missing.length > 1 ? 'are' : 'is'} not set: claims and NHCX eligibility checks are blocked.{' '}
        {canEdit
          ? <Link href="/rcm/settings" className="font-medium text-primary hover:underline">Set it in RCM settings</Link>
          : 'Ask an administrator to set it in RCM settings.'}
      </p>
    </div>
  )
}
