'use client'
import { forwardRef, useState } from 'react'
import { DESIGN_STYLES, type Design } from '@/components/auth/auth-styles'

// A sign-in input whose look comes from the active design: a floating label
// (moves with transform only, so the field box never resizes) or a fixed
// label above. The real <label for> keeps getByLabelText / screen readers exact.
type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  design?: Design
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
  { id, label, value, onChange, design = 'a', invalid, trailing, below, hint, hintId, className = '', onFocus, onBlur, ...rest },
  ref,
) {
  const s = DESIGN_STYLES[design]
  const [focused, setFocused] = useState(false)
  const floated = focused || value.length > 0
  const input = (
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
      className={`${s.input} ${trailing ? 'pr-20' : ''} ${className}`}
    />
  )
  return (
    <div className="relative min-w-0">
      {s.labelMode === 'above' ? (
        <div className="group relative">
          <label htmlFor={id} className={s.label}>{label}</label>
          <div className="relative">
            {input}
            {trailing ? <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div> : null}
          </div>
        </div>
      ) : (
        <div className="relative">
          {input}
          <label
            htmlFor={id}
            className={`pointer-events-none absolute top-[18px] origin-left select-none leading-5 transition-[transform,color] duration-200 ease-out peer-autofill:-translate-y-[9px] peer-autofill:scale-[0.8] peer-data-[floated=true]:-translate-y-[9px] peer-data-[floated=true]:scale-[0.8] ${s.label}`}
          >
            {label}
          </label>
          {trailing ? <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div> : null}
        </div>
      )}
      {below ? <div className="pointer-events-none absolute left-1 top-full mt-1 text-xs leading-4">{below}</div> : null}
      {hint ? <p id={hintId} className={s.hint}>{hint}</p> : null}
    </div>
  )
})
