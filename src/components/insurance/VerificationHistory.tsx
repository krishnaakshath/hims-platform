// WS12 T4: a policy's current verification (who, when, source, method, reference, limits, until)
// and its recent history, newest first (as getCoverageSummary orders it). Shown only to
// COVERAGE_READ_ROLES on the Insurance tab; the reference is staff-facing and never logged.
import { formatPaise } from '@/lib/format'
import { formatIstDate, formatIstDateTime } from '@/lib/india-time'
import { MOCK_LABEL, type CoverageLimits, type CoverageVerificationFacts, type VerificationMethod } from '@/lib/insurance/coverage'

const SOURCE_LABEL: Record<CoverageVerificationFacts['source'], string> = { nhcx: 'NHCX', nhcx_mock: 'NHCX sandbox mock', manual: 'manual check' }
const METHOD_LABEL: Record<VerificationMethod, string> = { insurer_portal: 'insurer portal', tpa_portal: 'TPA portal', phone: 'phone', email: 'email', letter: 'letter' }
const RESULT_LABEL: Record<CoverageVerificationFacts['result'], string> = { active: 'Policy active', inactive: 'Not in force', error: 'Check failed' }

export function verificationSource(v: Pick<CoverageVerificationFacts, 'source' | 'method'>): string {
  const method = v.method && v.method in METHOD_LABEL ? METHOD_LABEL[v.method as VerificationMethod] : null
  return v.source === 'manual' && method ? `${SOURCE_LABEL.manual} by ${method}` : SOURCE_LABEL[v.source]
}

export function limitParts(l: CoverageLimits): string[] {
  const parts: string[] = []
  if (l.sumInsuredPaise !== null) parts.push(`Sum insured ${formatPaise(l.sumInsuredPaise)}`)
  if (l.balancePaise !== null) parts.push(`Balance ${formatPaise(l.balancePaise)}`)
  if (l.copayBp !== null) parts.push(`Co-pay ${l.copayBp / 100}%`)
  if (l.roomRentLimitPaise !== null) parts.push(`Room rent ${formatPaise(l.roomRentLimitPaise)}/day`)
  if (l.icuLimitPaise !== null) parts.push(`ICU ${formatPaise(l.icuLimitPaise)}/day`)
  return parts
}

export function VerificationHistory({ policyId, current, history }: { policyId: number; current: CoverageVerificationFacts | null; history: CoverageVerificationFacts[] }) {
  if (!current && history.length === 0) return <p className="text-xs text-muted-foreground">No verification on record.</p>
  const limits = current ? limitParts(current.limits) : []
  return (
    <div className="space-y-2 text-xs">
      {current && (
        <div data-testid={`current-verification-${policyId}`} className="rounded-md bg-muted/50 p-2">
          <p>
            <span className="font-medium">{RESULT_LABEL[current.result]}</span>: verified by {current.verifiedByName} on {formatIstDateTime(current.verifiedAt)} via {verificationSource(current)}
            {current.source === 'nhcx_mock' && <span className="ml-1 font-semibold text-amber-800">({MOCK_LABEL})</span>}
          </p>
          <p className="text-muted-foreground">
            {current.insurerReference ? `Reference ${current.insurerReference} · ` : ''}Valid until {formatIstDate(current.validUntil)}
          </p>
          {limits.length > 0 && <p className="text-muted-foreground">{limits.join(' · ')}</p>}
        </div>
      )}
      {history.length > 0 && (
        <div>
          <p className="font-medium text-muted-foreground">Recent verifications</p>
          <ul data-testid={`verification-history-${policyId}`} className="mt-1 space-y-0.5">
            {history.map((h) => (
              <li key={h.id}>
                {formatIstDateTime(h.verifiedAt)} · {RESULT_LABEL[h.result]} · {h.verifiedByName} via {verificationSource(h)}
                {h.source === 'nhcx_mock' ? ` (${MOCK_LABEL})` : ''}{h.insurerReference ? ` · ref ${h.insurerReference}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
