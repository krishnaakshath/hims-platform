// WS12 T4: a coverage verdict as a badge (patient header, Insurance tab; Task 8 reuses it).
// Colour follows severity; a policy that is not usable (expired, not started, marked inactive,
// or the insurer says not in force) is red in every context, because the cover is not there even
// where it does not block. Mock answers always carry the sandbox label.
import { MOCK_LABEL, type CoverageState, type CoverageVerdict } from '@/lib/insurance/coverage'

type Tone = 'green' | 'neutral' | 'amber' | 'red'

const NOT_IN_FORCE: readonly CoverageState[] = ['policy_expired', 'policy_not_started', 'policy_inactive', 'verified_inactive']

const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-emerald-500/10 text-emerald-800 border-emerald-500/30',
  neutral: 'bg-muted text-muted-foreground border-border',
  amber: 'bg-amber-500/10 text-amber-800 border-amber-500/30',
  red: 'bg-red-500/10 text-red-700 border-red-500/30',
}

export function coverageTone(verdict: CoverageVerdict): Tone {
  if (verdict.severity === 'block' || NOT_IN_FORCE.includes(verdict.state)) return 'red'
  if (verdict.severity === 'warn') return 'amber'
  if (verdict.severity === 'ok') return 'green'
  return 'neutral'
}

export function CoverageBadge({ verdict }: { verdict: CoverageVerdict }) {
  const tone = coverageTone(verdict)
  return (
    <span role="status" data-tone={tone} title={verdict.detail ?? undefined}
      className={`inline-flex flex-wrap items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>
      <span>{verdict.label}</span>
      {verdict.isMock && <span className="rounded bg-amber-500/20 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-900">{MOCK_LABEL}</span>}
    </span>
  )
}
