'use client'
import { MONO_LABEL } from '@/components/auth/auth-styles'

export type Audience = 'staff' | 'patient'

const OPTIONS: { value: Audience; label: string }[] = [
  { value: 'staff', label: 'Staff' },
  { value: 'patient', label: 'Patient' },
]

// Staff | Patient as record tabs (a radiogroup): monospaced, fixed width, with
// a bar that slides under the active tab using transform only -- switching
// never reflows anything.
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
    <div role="radiogroup" aria-label="Sign in as" onKeyDown={onKeyDown} className="relative grid h-11 w-[216px] grid-cols-2 border-b border-foreground/15">
      <span
        aria-hidden="true"
        className="absolute -bottom-px left-0 h-[3px] w-1/2 rounded-full bg-primary transition-transform duration-300 ease-[cubic-bezier(0.3,0.7,0.2,1)]"
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
            className={`relative z-10 rounded-t-md ${MONO_LABEL} transition-colors duration-200 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 ${checked ? 'text-foreground' : 'text-foreground/65 hover:text-foreground'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
