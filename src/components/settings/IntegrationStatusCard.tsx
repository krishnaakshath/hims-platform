// The shape of src/lib/integrations/config.ts CapabilityStatus (not imported: config is server-only).
export type CapabilityStatus = {
  key: 'abha' | 'scan_share' | 'nhcx_submit' | 'nhcx_callbacks' | 'nhcx_eligibility'
  state: 'configured' | 'mock' | 'not_configured'
  label: string
  missing: string[]
}

const NAME: Record<CapabilityStatus['key'], string> = {
  abha: 'ABHA create and verify', scan_share: 'ABHA Scan & Share', nhcx_submit: 'NHCX pre-auth and claims', nhcx_callbacks: 'NHCX insurer responses', nhcx_eligibility: 'NHCX eligibility',
}
const TONE: Record<CapabilityStatus['state'], string> = {
  configured: 'border-emerald-300 bg-emerald-50 text-emerald-800', mock: 'border-amber-300 bg-amber-50 text-amber-900', not_configured: 'border-border bg-muted text-muted-foreground',
}

// One capability: its state and, when not configured, the env variable NAMES still missing.
export function IntegrationStatusCard({ status }: { status: CapabilityStatus }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{NAME[status.key]}</h3>
        <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE[status.state]}`}>{status.label}</span>
      </div>
      {status.missing.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Missing: <span className="font-mono">{status.missing.join(', ')}</span></p>
      )}
    </div>
  )
}
