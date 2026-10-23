import type { CSSProperties } from 'react'

// Shared class strings for every sign-in surface (staff, per-portal, patient,
// MFA). One accent only: `primary`, which the brand config overrides per
// deployment. Fields are 56px, buttons 52px; inputs use 16px text below `sm` so iOS
// never zooms on focus.

export const AUTH_LABEL = 'block text-[13px] font-medium leading-5 text-foreground'

export const AUTH_INPUT =
  'block h-12 w-full rounded-lg border border-input bg-card px-4 text-base text-foreground shadow-[0_1px_1px_rgb(0_0_0/0.03)] ' +
  'transition-[border-color,box-shadow] placeholder:text-muted-foreground/70 hover:border-foreground/20 ' +
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20 ' +
  'aria-[invalid=true]:border-destructive disabled:cursor-not-allowed disabled:opacity-50 sm:text-[15px]'

export const AUTH_CODE_INPUT =
  'block h-16 w-full rounded-xl border border-input bg-card px-3 text-center font-mono text-[28px] tabular-nums tracking-[0.5em] indent-[0.5em] text-foreground ' +
  'transition-[border-color,box-shadow] placeholder:text-muted-foreground/40 hover:border-foreground/20 ' +
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/20'

export const AUTH_PRIMARY_BUTTON =
  'auth-cta relative inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-[15px] font-semibold tracking-[-0.005em] text-primary-foreground ' +
  'shadow-[0_1px_2px_rgb(0_0_0/0.12),0_8px_20px_-8px_color-mix(in_oklch,var(--primary)_55%,transparent)] transition-[background-color,box-shadow,transform] duration-200 ' +
  'hover:bg-primary/92 hover:shadow-[0_1px_2px_rgb(0_0_0/0.12),0_12px_28px_-10px_color-mix(in_oklch,var(--primary)_65%,transparent)] active:scale-[0.985] ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card ' +
  'disabled:cursor-not-allowed disabled:opacity-70 disabled:shadow-none'

export const AUTH_QUIET_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors ' +
  'hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25'

export const AUTH_LINK_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-primary underline-offset-4 ' +
  'hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25'

export const AUTH_ALERT = 'rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3.5 py-3 text-sm leading-5 text-destructive'

export const AUTH_TITLE = 'text-[32px] font-semibold leading-10 tracking-[-0.03em] text-foreground sm:text-[40px] sm:leading-[48px] xl:text-[44px] xl:leading-[52px]'
export const AUTH_SUBTITLE = 'mt-1.5 text-sm leading-6 text-muted-foreground'

// Stagger index for the entrance choreography (.auth-rise in globals.css).
export function rise(i: number): CSSProperties {
  return { '--i': i } as CSSProperties
}
