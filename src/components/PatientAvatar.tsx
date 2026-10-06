// Deterministic initials avatar -- same patient always gets the same color,
// cycling through the design system's chart tokens rather than a hardcoded
// palette so it stays consistent with the rest of the theme.
const COLOR_CLASSES = [
  'bg-primary/15 text-primary',
  'bg-accent/15 text-accent',
  'bg-sky-500/15 text-sky-700',
  'bg-chart-4/15 text-chart-4',
  'bg-amber-500/15 text-amber-700',
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function PatientAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  const colorClass = COLOR_CLASSES[hashString(name) % COLOR_CLASSES.length]
  const sizeClass = size === 'sm' ? 'h-8 w-8 text-xs' : size === 'lg' ? 'h-14 w-14 text-lg' : 'h-10 w-10 text-sm'
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${colorClass} ${sizeClass}`} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
