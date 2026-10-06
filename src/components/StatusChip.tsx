import type { Verdict } from '@/lib/rule-engine'

// Status is always a colored dot + plain text label, never an icon glyph.
// The dot is decorative (aria-hidden) -- the text label alone satisfies
// "never color alone" on its own.
const CONFIG: Record<Verdict, { label: string; dotClassName: string; textClassName: string }> = {
  green: { label: 'Meets', dotClassName: 'bg-success', textClassName: 'text-success' },
  yellow: { label: 'Needs Verification', dotClassName: 'bg-warning', textClassName: 'text-warning' },
  red: { label: 'Potential Exclusion', dotClassName: 'bg-destructive', textClassName: 'text-destructive' },
}

export function StatusChip({ status }: { status: Verdict }) {
  const { label, dotClassName, textClassName } = CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${textClassName}`}>
      <span className={`h-2 w-2 rounded-full ${dotClassName}`} aria-hidden="true" />
      {label}
    </span>
  )
}
