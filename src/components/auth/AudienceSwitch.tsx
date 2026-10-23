'use client'

export type Audience = 'staff' | 'patient'

const OPTIONS: { value: Audience; label: string }[] = [
  { value: 'staff', label: 'Staff' },
  { value: 'patient', label: 'Patient' },
]

// Two-option segmented control (radiogroup) with a sliding thumb. Fixed
// width, thumb moves with transform only, so switching never reflows.
export function AudienceSwitch({ value, onChange }: { value: Audience; onChange: (value: Audience) => void }) {
  const index = OPTIONS.findIndex((o) => o.value === value)

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    e.preventDefault()
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? 1 : (index + 1) % 2
    onChange(OPTIONS[next].value)
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Sign in as"
      onKeyDown={onKeyDown}
      className="relative grid h-11 w-[232px] grid-cols-2 rounded-full border border-border bg-muted/70 p-1"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-full bg-card dark:bg-[oklch(0.34_0.006_70)] shadow-[0_1px_2px_rgb(0_0_0/0.08),0_2px_8px_-2px_rgb(0_0_0/0.08)] ring-1 ring-border/60 transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)]"
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
            className={`relative z-10 rounded-full text-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 ${checked ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
