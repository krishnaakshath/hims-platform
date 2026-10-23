import { PLUS_BAR, PLUS_LENGTH, PLUS_RADIUS, PULSE_PATH, PULSE_STROKE } from '@/lib/brand-icon'

// The "pulse plus" mark -- the same geometry as the favicon / app icon
// (src/lib/brand-icon.ts) -- drawn with CSS variables instead of baked hex so
// it follows the deployment's brand colour (`--brand`) in light and dark.
// On sign-in the heartbeat cut draws itself once (.auth-draw); under reduced
// motion it is simply drawn.
export function BrandMark({ className = 'h-10 w-10', tile = 'var(--brand)', glyph = 'white' }: { className?: string; tile?: string; glyph?: string }) {
  const c = 16
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={`shrink-0 ${className}`}>
      <rect width="32" height="32" rx="8" fill={tile} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="none" stroke="white" strokeOpacity="0.18" />
      <rect x={c - PLUS_BAR / 2} y={c - PLUS_LENGTH / 2} width={PLUS_BAR} height={PLUS_LENGTH} rx={PLUS_RADIUS} fill={glyph} />
      <rect x={c - PLUS_LENGTH / 2} y={c - PLUS_BAR / 2} width={PLUS_LENGTH} height={PLUS_BAR} rx={PLUS_RADIUS} fill={glyph} />
      <path className="auth-draw" pathLength={1} d={PULSE_PATH} fill="none" stroke={tile} strokeWidth={PULSE_STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
