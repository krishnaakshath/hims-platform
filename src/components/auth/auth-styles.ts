import type { CSSProperties } from 'react'

// Shared class strings for the sign-in surfaces. Three review concepts
// ("designs") share the form logic but not the look:
//   a -- immersive: glass controls on a full-bleed animated brand field
//   b -- chart: a clinical record / ID badge, monospaced labels, boxed fields
//   c -- typographic: borderless underlined fields, oversized type
// One accent only (`primary` / `--brand`), which brand config overrides.
export type Design = 'a' | 'b' | 'c'
export const DESIGNS: Design[] = ['a', 'b', 'c']

// MFA, OTP and other shared steps keep the neutral style below.
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
  'auth-cta relative inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-primary px-6 text-[15px] font-semibold tracking-[-0.005em] text-primary-foreground ' +
  'shadow-[0_1px_2px_rgb(0_0_0/0.12),0_8px_20px_-8px_color-mix(in_oklch,var(--primary)_55%,transparent)] transition-[background-color,box-shadow,transform] duration-200 ' +
  'hover:bg-primary/92 active:scale-[0.985] ' +
  'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card ' +
  'disabled:cursor-not-allowed disabled:opacity-70 disabled:shadow-none'

export const AUTH_QUIET_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors ' +
  'hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25'

export const AUTH_LINK_BUTTON =
  'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-primary underline-offset-4 ' +
  'hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25'

export const AUTH_ALERT = 'rounded-xl border border-destructive/25 bg-destructive/[0.06] px-3.5 py-3 text-sm leading-5 text-destructive'

export interface DesignStyles {
  /** Wrapper around the heading block. */
  head: string
  eyebrow: string
  title: string
  subtitle: string
  /** The <form> element (layout). */
  form: string
  /** Field box (input) and floating/fixed label. */
  input: string
  label: string
  labelMode: 'float' | 'above'
  /** Trailing toggle (Show/Hide). */
  toggle: string
  hint: string
  alert: string
  /** Wrapper + button classes for submit. */
  submitWrap: string
  button: string
  link: string
  /** Wrapper for the "below the form" slot (department menu / OTP link). */
  below: string
}

export const DESIGN_STYLES: Record<Design, DesignStyles> = {
  // Immersive: glass on a deep brand field. Light text on dark always.
  a: {
    head: 'mb-6',
    eyebrow: 'mb-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--auth-line)]',
    title: 'text-[26px] font-semibold leading-8 tracking-[-0.02em] text-white',
    subtitle: 'mt-1 text-sm leading-6 text-white/70',
    form: 'space-y-3.5',
    input:
      'peer block h-14 w-full rounded-xl border border-white/15 bg-white/[0.07] px-4 pb-2 pt-6 text-base text-white outline-none backdrop-blur-sm ' +
      'transition-[border-color,background-color,box-shadow] duration-200 placeholder:text-transparent hover:border-white/30 ' +
      'focus:border-[var(--auth-line)] focus:bg-white/[0.1] focus:shadow-[0_0_0_4px_color-mix(in_oklch,var(--auth-line)_22%,transparent)] focus:placeholder:text-white/45 ' +
      'aria-[invalid=true]:border-red-300 autofill:shadow-[inset_0_0_0_1000px_var(--auth-panel-deep)] autofill:[-webkit-text-fill-color:white] sm:text-[15px]',
    label:
      'left-4 text-[15px] text-white/65 peer-focus:text-[var(--auth-line)] peer-aria-[invalid=true]:text-red-200',
    labelMode: 'float',
    toggle: 'text-white/70 hover:bg-white/10 hover:text-white focus-visible:ring-white/40',
    hint: 'mt-2 px-1 text-xs leading-5 text-white/70',
    alert: 'rounded-xl border border-red-300/40 bg-red-400/15 px-3.5 py-3 text-sm leading-5 text-red-50',
    submitWrap: 'pt-2',
    button:
      'auth-cta relative inline-flex h-[52px] w-full items-center justify-center gap-2 rounded-xl bg-white px-6 text-[15px] font-semibold text-[var(--auth-panel-deep)] ' +
      'shadow-[0_10px_30px_-10px_rgb(0_0_0/0.5)] transition-[transform,background-color,opacity] duration-200 hover:bg-white/90 active:scale-[0.985] ' +
      'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-60',
    link:
      'inline-flex min-h-11 w-full items-center justify-center rounded-lg px-3 text-sm font-medium text-white/85 underline-offset-4 hover:text-white hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-white/40',
    below: 'mt-4 border-t border-white/10 pt-3',
  },
  // Chart: clinical record. Monospaced uppercase labels above boxed fields.
  b: {
    head: 'mb-6',
    eyebrow: 'mb-1 font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-primary',
    title: 'text-[28px] font-semibold leading-9 tracking-[-0.02em] text-foreground',
    subtitle: 'mt-0.5 text-sm leading-6 text-muted-foreground',
    form: 'space-y-4',
    input:
      'peer block h-12 w-full rounded-md border border-dashed border-foreground/25 bg-[color-mix(in_oklch,var(--brand)_3%,var(--card))] px-3.5 font-mono text-[15px] text-foreground outline-none ' +
      'transition-[border-color,box-shadow,background-color] duration-200 placeholder:text-muted-foreground/60 hover:border-foreground/40 ' +
      'focus:border-solid focus:border-primary focus:bg-card focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_16%,transparent)] aria-[invalid=true]:border-solid aria-[invalid=true]:border-destructive',
    label: 'mb-1.5 block font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground transition-colors group-focus-within:text-primary',
    labelMode: 'above',
    toggle: 'font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-primary/25',
    hint: 'mt-1.5 text-xs leading-5 text-muted-foreground',
    alert: 'rounded-md border border-destructive/30 bg-destructive/[0.06] px-3 py-2.5 font-mono text-[13px] leading-5 text-destructive',
    submitWrap: 'pt-2',
    button:
      'auth-cta relative inline-flex h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-6 font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-primary-foreground ' +
      'transition-[transform,background-color] duration-200 hover:bg-primary/90 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30 focus-visible:ring-offset-2 focus-visible:ring-offset-card ' +
      'disabled:cursor-not-allowed disabled:opacity-60',
    link:
      'inline-flex min-h-11 w-full items-center justify-center rounded-md px-3 font-mono text-[12px] uppercase tracking-[0.12em] text-primary hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25',
    below: 'mt-5 border-t border-dashed border-foreground/20 pt-2',
  },
  // Typographic: no boxes. Underlined fields with floating labels; on wide
  // screens the staff form is one line: email, password, button.
  c: {
    head: 'mb-6',
    eyebrow: 'mb-2 text-sm font-medium text-primary',
    title: 'sr-only',
    subtitle: 'text-[17px] leading-7 text-muted-foreground',
    form: 'grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:items-end',
    input:
      'peer block h-14 w-full rounded-none border-0 border-b-2 border-foreground/20 bg-transparent px-0 pb-1.5 pt-6 text-[19px] text-foreground outline-none ' +
      'transition-[border-color] duration-200 placeholder:text-transparent hover:border-foreground/40 focus:border-primary focus:placeholder:text-muted-foreground/50 ' +
      'aria-[invalid=true]:border-destructive autofill:shadow-[inset_0_0_0_1000px_var(--background)]',
    label: 'left-0 text-[17px] text-muted-foreground peer-focus:text-primary peer-aria-[invalid=true]:text-destructive',
    labelMode: 'float',
    toggle: 'text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:ring-primary/25',
    hint: 'mt-2 text-xs leading-5 text-muted-foreground',
    alert: 'border-l-2 border-destructive py-1 pl-3 text-sm leading-5 text-destructive lg:col-span-3',
    submitWrap: 'lg:pb-0.5',
    button:
      'auth-cta relative inline-flex h-14 w-full items-center justify-center gap-3 rounded-full bg-primary px-8 text-base font-semibold text-primary-foreground ' +
      'transition-[transform,opacity] duration-200 hover:opacity-90 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
      'disabled:cursor-not-allowed disabled:opacity-55 lg:w-auto lg:min-w-[168px]',
    link:
      'inline-flex min-h-11 items-center rounded-md px-0 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/25',
    below: 'mt-8',
  },
}

// Stagger index for the entrance choreography (.auth-rise in globals.css).
export function rise(i: number): CSSProperties {
  return { '--i': i } as CSSProperties
}
