'use client'
import { useSyncExternalStore } from 'react'
import { useBrand } from '@/components/BrandProvider'
import { BrandMark } from '@/components/auth/BrandMark'
import { PulseTrace, useLoginQuote, useMotionState } from '@/components/auth/auth-common'
import { rise } from '@/components/auth/auth-styles'
import type { Audience } from '@/components/auth/AudienceSwitch'

// DESIGN B -- the patient chart / ID badge. The page is ECG paper (a fine
// brand-tinted grid with a slow sweep trace); the sign-in is an ID badge
// hanging from a lanyard on the left, with a coloured header band, a slot
// notch, monospaced labels and a date stamp. The right side reads like the
// top of a clinical record: a monospaced header and the quote as a note.
//
// Rigid: fixed scroll container with a stable gutter; the badge hangs from a
// fixed top offset (never centred), the stamp's date fills a fixed-width chip.
const noop = () => () => {}
function today(): string {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase()
}

export function ShellChart({ children, audience }: { children: React.ReactNode; audience: Audience }) {
  const { name, logoUrl } = useBrand()
  const quote = useLoginQuote()
  const motion = useMotionState()
  const date = useSyncExternalStore(noop, today, () => '')
  const year = new Date().getFullYear()
  return (
    <div
      data-motion={motion}
      data-design="b"
      className="fixed inset-0 overflow-y-auto overscroll-contain bg-[color-mix(in_oklch,var(--brand)_4%,var(--background))] text-foreground [scrollbar-gutter:stable] selection:bg-primary/15"
    >
      <ChartPaper />
      <div className="relative z-10 mx-auto grid min-h-dvh max-w-[1440px] gap-10 px-4 pb-10 sm:px-8 lg:grid-cols-[460px_minmax(0,1fr)] lg:gap-20 lg:px-16">
        {/* The badge, hanging from its lanyard. */}
        <div className="flex flex-col items-center">
          <div aria-hidden="true" data-decorative="" className="relative h-[clamp(28px,7vh,84px)] w-24">
            <span className="absolute left-[30%] top-0 h-full w-2.5 -skew-x-[14deg] rounded-b-sm bg-[var(--auth-panel)]" />
            <span className="absolute right-[30%] top-0 h-full w-2.5 skew-x-[14deg] rounded-b-sm bg-[var(--auth-panel)]" />
          </div>
          <div aria-hidden="true" data-decorative="" className="-mt-1 h-5 w-10 rounded-t-md border-x-2 border-t-2 border-foreground/30" />
          <article
            data-auth-panel=""
            className="auth-rise relative w-full max-w-[460px] rounded-[22px] border border-foreground/15 bg-card shadow-[0_1px_0_var(--border),0_30px_60px_-30px_rgb(0_0_0/0.35)]"
            style={rise(0)}
          >
            <header className="relative overflow-hidden rounded-t-[21px] bg-[var(--auth-panel)] px-6 pb-5 pt-7 text-[var(--auth-panel-foreground)] sm:px-8">
              <span aria-hidden="true" className="absolute left-1/2 top-2.5 h-2.5 w-16 -translate-x-1/2 rounded-full bg-[color-mix(in_oklch,var(--brand)_4%,var(--background))]" />
              <svg aria-hidden="true" className="absolute inset-x-0 bottom-0 h-10 w-full" viewBox="0 0 460 40" preserveAspectRatio="none" fill="none">
                <PulseTrace width={460} beats={2} y={22} amp={0.38} base="white" glow="var(--auth-line)" baseOpacity={0.14} glowOpacity={0.7} strokeWidth={1.5} />
              </svg>
              <div className="relative flex items-center justify-between gap-4">
                <span className="inline-flex min-w-0 items-center gap-3">
                  {logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrl} alt={name} className="h-9 w-auto" />
                  ) : (
                    <>
                      <BrandMark className="h-10 w-10" />
                      <span className="truncate text-lg font-semibold tracking-[-0.015em]">{name}</span>
                    </>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--auth-panel-muted)]">
                  {audience === 'patient' ? 'Patient' : 'Staff'}
                </span>
              </div>
            </header>
            <div className="relative px-6 pb-6 pt-6 sm:px-8 sm:pb-7">
              {/* Date stamp: decorative, fixed size, slightly rotated. */}
              <span
                aria-hidden="true"
                data-decorative=""
                className="absolute right-5 top-5 hidden h-9 w-[132px] sm:flex -rotate-6 items-center justify-center rounded-md border-2 border-double border-primary/45 font-mono text-[11px] font-semibold tracking-[0.14em] text-primary/75 sm:right-7"
              >
                {date}
              </span>
              {children}
            </div>
          </article>
        </div>

        {/* The record header and the quote as a clinical note (wide screens). */}
        <div className="hidden pt-[clamp(72px,14vh,160px)] lg:block">
          <p className="auth-rise font-mono text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground" style={rise(1)}>
            Record &middot; {name}
          </p>
          <div className="auth-rise mt-4 border-y border-dashed border-foreground/20 py-10" style={rise(2)}>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">Note</p>
            <blockquote className="mt-4 max-w-[22ch] font-serif text-[clamp(32px,3.2vw,52px)] leading-[1.12] tracking-[-0.01em] text-foreground">
              {quote.text}
            </blockquote>
            {quote.attribution ? (
              <p className="mt-6 font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">{quote.attribution}</p>
            ) : null}
          </div>
          <p className="mt-6 font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">&copy; {year} {name}</p>
        </div>
        <p className="text-center font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground lg:hidden">&copy; {year} {name}</p>
      </div>
    </div>
  )
}

// ECG paper: minor and major grid lines in the brand tint, static, plus one
// slow sweep trace across the lower part of the page.
function ChartPaper() {
  return (
    <div aria-hidden="true" data-decorative="" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="auth-ecg-paper absolute inset-0" />
      <svg className="absolute inset-x-0 bottom-[14%] h-[180px] w-full" viewBox="0 0 1600 180" preserveAspectRatio="none" fill="none">
        <PulseTrace width={1600} beats={5} y={100} amp={1} base="var(--brand)" glow="var(--brand)" baseOpacity={0.12} glowOpacity={0.45} strokeWidth={2} />
      </svg>
    </div>
  )
}
