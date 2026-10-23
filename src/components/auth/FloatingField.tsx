'use client'
import { forwardRef, useState } from 'react'

// A 56px input with a floating label and an animated focus underline. The
// label is absolutely positioned and moves with transform only; the field's
// box never changes size. Floats on focus, when filled, and on browser
// autofill. The real <label for> keeps getByLabelText / screen readers exact.
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
  { id, label, value, onChange, invalid, trailing, below, hint, hintId, className = '', onFocus, onBlur, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false)
  const floated = focused || value.length > 0
  return (
    <div className="group relative">
      <div className="relative">
        <input
          ref={ref}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...rest}
          onFocus={(e) => { setFocused(true); onFocus?.(e) }}
          onBlur={(e) => { setFocused(false); onBlur?.(e) }}
          aria-invalid={invalid ? true : undefined}
          data-floated={floated ? 'true' : 'false'}
          className={`peer block h-14 w-full rounded-xl border border-input bg-card px-4 pb-2 pt-6 text-base text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.04)] outline-none transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-transparent hover:border-foreground/25 focus:border-primary focus:shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_14%,transparent)] focus:placeholder:text-muted-foreground/55 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus:shadow-[0_0_0_4px_color-mix(in_oklch,var(--destructive)_14%,transparent)] autofill:shadow-[inset_0_0_0_1000px_var(--card)] sm:text-[15px] ${trailing ? 'pr-20' : ''} ${className}`}
        />
        <label
          htmlFor={id}
          className="pointer-events-none absolute left-4 top-[18px] origin-left select-none text-[15px] leading-5 text-muted-foreground transition-[transform,color] duration-200 ease-out peer-autofill:-translate-y-[9px] peer-autofill:scale-[0.8] peer-focus:text-primary peer-data-[floated=true]:-translate-y-[9px] peer-data-[floated=true]:scale-[0.8] peer-aria-[invalid=true]:text-destructive"
        >
          {label}
        </label>
        {trailing ? <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div> : null}
        {below ? <div className="absolute left-1 top-full mt-1 text-xs leading-4">{below}</div> : null}
      </div>
      {hint ? (
        <p id={hintId} className="mt-2 px-1 text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
})
