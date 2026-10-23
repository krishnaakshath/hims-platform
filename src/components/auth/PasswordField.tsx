'use client'
import { useState } from 'react'
import { FloatingField } from '@/components/auth/FloatingField'
import { BADGE } from '@/components/auth/auth-styles'

// Password input with a text "Show"/"Hide" toggle and a Caps Lock hint that
// sits under the field without taking layout space (nothing reflows when it
// appears).
export function PasswordField({
  id = 'password',
  value,
  onChange,
  required,
  invalid,
  autoComplete = 'current-password',
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  required?: boolean
  invalid?: boolean
  autoComplete?: string
}) {
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const hintId = `${id}-caps`

  function readCapsLock(e: React.KeyboardEvent<HTMLInputElement>) {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'))
  }

  return (
    <FloatingField
      id={id}
      label="Password"
      type={visible ? 'text' : 'password'}
      required={required}
      autoComplete={autoComplete}
      autoCapitalize="none"
      spellCheck={false}
      value={value}
      onChange={onChange}
      invalid={invalid}
      onKeyDown={readCapsLock}
      onKeyUp={readCapsLock}
      onBlur={() => setCapsLock(false)}
      aria-describedby={capsLock ? hintId : undefined}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-controls={id}
          aria-pressed={visible}
          aria-label={visible ? 'Hide password' : 'Show password'}
          className={`inline-flex h-10 w-16 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-[3px] ${BADGE.toggle}`}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      }
      below={
        <span id={hintId} aria-live="polite" className="font-mono text-xs font-semibold uppercase tracking-[0.1em] text-amber-800 dark:text-amber-300">
          {capsLock ? 'Caps Lock is on' : ''}
        </span>
      }
    />
  )
}
