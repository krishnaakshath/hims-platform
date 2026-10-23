'use client'
import type { Design } from '@/components/auth/auth-styles'

export type Audience = 'staff' | 'patient'

const OPTIONS: { value: Audience; label: string }[] = [
  { value: 'staff', label: 'Staff' },
  { value: 'patient', label: 'Patient' },
]

// Per-design look of the same radiogroup. Every variant has a fixed width
// and moves its indicator with transform only, so switching never reflows.
const LOOK: Record<Design, { group: string; thumb: string; on: string; off: string; option: string }> = {
  // Glass pill on the immersive field.
  a: {
    group: 'relative grid h-11 w-[224px] grid-cols-2 rounded-full border border-white/15 bg-white/[0.08] p-1 backdrop-blur-sm',
    thumb: 'absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-white shadow-[0_4px_14px_-4px_rgb(0_0_0/0.4)]',
    on: 'text-[var(--auth-panel-deep)]',
    off: 'text-white/75 hover:text-white',
    option: 'rounded-full text-sm font-semibold focus-visible:ring-white/50',
  },
  // Record tabs: monospaced, a sliding bar under the active tab.
  b: {
    group: 'relative grid h-11 w-[220px] grid-cols-2 border-b border-dashed border-foreground/25',
    thumb: 'absolute -bottom-px left-0 h-[3px] w-1/2 bg-primary',
    on: 'text-foreground',
    off: 'text-muted-foreground hover:text-foreground',
    option: 'font-mono text-[12px] font-semibold uppercase tracking-[0.16em] focus-visible:ring-primary/30',
  },
  // Inline words with a sliding underline.
  c: {
    group: 'relative grid h-11 w-[200px] grid-cols-2',
    thumb: 'absolute bottom-1 left-0 h-0.5 w-1/2 bg-primary',
    on: 'text-foreground',
    off: 'text-muted-foreground hover:text-foreground',
    option: 'text-left text-lg font-medium focus-visible:ring-primary/30',
  },
}

export function AudienceSwitch({ value, onChange, design = 'a' }: { value: Audience; onChange: (value: Audience) => void; design?: Design }) {
  const index = OPTIONS.findIndex((o) => o.value === value)
  const look = LOOK[design]

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (index + 1) % 2
    onChange(OPTIONS[next].value)
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label="Sign in as" onKeyDown={onKeyDown} className={look.group}>
      <span
        aria-hidden="true"
        className={`${look.thumb} transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)]`}
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {OPTIONS.map((o) => {
        const checked = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`relative z-10 transition-colors duration-200 focus-visible:outline-none focus-visible:ring-[3px] ${look.option} ${checked ? look.on : look.off}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
