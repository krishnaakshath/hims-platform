'use client'
import { useId, type ReactNode } from 'react'

export const INPUT_CLASS = 'w-full rounded-md border border-border px-3 py-2 text-sm'

// Label + control + hint + error wiring (aria-invalid / aria-describedby).
export function Field({ label, error, hint, required, children }: {
  label: string
  error?: string
  hint?: string
  required?: boolean
  children: (p: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string; required?: boolean }) => ReactNode
}) {
  const id = useId()
  const errId = `${id}-err`
  const hintId = `${id}-hint`
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={`block text-xs font-medium text-foreground${required ? " after:ml-0.5 after:content-['*']" : ''}`}>
        {label}
      </label>
      {children({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy, required })}
      {hint && <p id={hintId} className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p id={errId} role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>
}
