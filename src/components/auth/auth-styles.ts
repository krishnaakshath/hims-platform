import type { CSSProperties } from 'react'

// Class strings for the sign-in badge (the ID badge on a lanyard over ECG
// paper -- see ShellChart). One accent only: `primary` / `--brand`, which the
// brand config overrides per deployment. Monospaced labels are 12px+ and use
// colours that keep AA contrast on the card in light and dark.

// Neutral styles kept for the shared MFA / OTP steps.
export const AUTH_LABEL = 'block text-[13px] font-medium leading-5 text-foreground'

export const AUTH_INPUT =
  'block h-12 w-full rounded-lg border border-input bg-card px-4 text-base text-foreground shadow-[0_1px_1px_rgb(0_0_0/0.03)] ' +
  'transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-foreground/20 ' +
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20 ' +
  'aria-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:opacity-50 sm:text-[15px]'

export const AUTH_CODE_INPUT =
  'block h-16 w-full rounded-lg border border-input bg-card px-3 text-center font-mono text-[28px] tabular-nums tracking-[0.5em] indent-[0.5em] text-foreground ' +
  'transition-[border-color,box-shadow] placeholder:text-muted-foreground/40 hover:border-foreground/25 ' +
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20'

export const AUTH_QUIET_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors ' +
  'hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25'

export const AUTH_LINK_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-primary underline-offset-4 ' +
  'hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25'

export const AUTH_ALERT = 'rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3.5 py-3 text-sm leading-5 text-destructive'

/** Monospaced uppercase label: 12px, wide tracking, AA on the card. */
export const MONO_LABEL = 'font-mono text-xs font-semibold uppercase tracking-[0.12em]'

export const BADGE = {
  head: 'mb-6',
  eyebrow: `mb-1.5 ${MONO_LABEL} text-primary`,
  title: 'text-[30px] font-semibold leading-9 tracking-[-0.025em] text-foreground',
  subtitle: 'mt-1 text-[15px] leading-6 text-muted-foreground',
  form: 'space-y-4',
  label: `mb-2 block ${MONO_LABEL} text-foreground/75 transition-colors group-focus-within:text-primary`,
  input:
    'block h-12 w-full rounded-lg border border-foreground/20 bg-[color-mix(in_oklch,var(--brand)_3%,var(--card))] px-3.5 font-mono text-[15px] text-foreground outline-none ' +
    'shadow-[inset_0_1px_2px_rgb(0_0_0/0.05)] transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/70 hover:border-foreground/35 ' +
    'focus:border-primary focus:bg-card focus:shadow-[inset_0_1px_2px_rgb(0_0_0/0.04),0_0_0_3px_color-mix(in_oklch,var(--primary)_18%,transparent)] ' +
    'aria-[invalid=true]:border-destructive autofill:shadow-[inset_0_0_0_1000px_var(--card)]',
  toggle: `${MONO_LABEL} text-foreground/70 hover:bg-secondary hover:text-foreground focus-visible:ring-primary/25`,
  hint: 'mt-2 text-[13px] leading-5 text-muted-foreground',
  alert: 'rounded-lg border border-destructive/35 bg-destructive/[0.06] px-3.5 py-2.5 text-sm leading-5 text-destructive',
  submitWrap: 'pt-2',
  button:
    'auth-cta relative inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 font-mono text-[13px] font-semibold uppercase tracking-[0.16em] text-primary-foreground ' +
    'shadow-[inset_0_1px_0_rgb(255_255_255/0.14),0_1px_2px_rgb(0_0_0/0.18),0_10px_22px_-12px_color-mix(in_oklch,var(--primary)_70%,transparent)] ' +
    'transition-[transform,background-color,box-shadow] duration-200 hover:bg-primary/92 active:scale-[0.985] ' +
    'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card ' +
    'disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none',
  link:
    `inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 ${MONO_LABEL} text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25`,
  below: 'mt-5 border-t border-dashed border-foreground/20 pt-2',
} as const

// Stagger index for the entrance choreography (.auth-rise in globals.css).
export function rise(i: number): CSSProperties {
  return { '--i': i } as CSSProperties
}

/** The primary button: the badge's button, shared by MFA / OTP steps. */
export const AUTH_PRIMARY_BUTTON = BADGE.button
