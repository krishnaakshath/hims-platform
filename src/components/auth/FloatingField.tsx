'use client'
import { forwardRef } from 'react'
import { BADGE } from '@/components/auth/auth-styles'

// A sign-in field on the badge: a monospaced label above a boxed input. The
// real <label for> keeps getByLabelText / screen readers exact. Extra content
// rendered `below` is absolutely positioned so it never changes the height.
type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  invalid?: boolean
  /** Rendered inside the field on the right (e.g. a Show/Hide button). */
  trailing?: React.ReactNode
  /** Rendered under the field without taking layout space (e.g. Caps Lock). */
  below?: React.ReactNode
  /** Visible helper text under the field (takes space; wire aria-describedby). */
  hint?: React.ReactNode
  hintId?: string
}

export const FloatingField = forwardRef<HTMLInputElement, Props>(function FloatingField(
  { id, label, value, onChange, invalid, trailing, below, hint, hintId, className = '', ...rest },
  ref,
) {
  return (
    <div className="group relative min-w-0">
      <label htmlFor={id} className={BADGE.label}>{label}</label>
      <div className="relative">
        <input
          ref={ref}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
          aria-invalid={invalid ? true : undefined}
          className={`${BADGE.input} ${trailing ? 'pr-20' : ''} ${className}`}
        />
        {trailing ? <div className="absolute inset-y-0 right-1 flex items-center">{trailing}</div> : null}
        {below ? <div className="pointer-events-none absolute left-0.5 top-full mt-1 text-xs leading-4">{below}</div> : null}
      </div>
      {hint ? <p id={hintId} className={BADGE.hint}>{hint}</p> : null}
    </div>
  )
})
