'use client'
import { useSyncExternalStore } from 'react'
import { useBrand } from '@/components/BrandProvider'
import { BrandMark } from '@/components/auth/BrandMark'
import { PulseTrace, useLoginQuote, useMotionState } from '@/components/auth/auth-common'
import { MONO_LABEL, rise } from '@/components/auth/auth-styles'
import type { Audience } from '@/components/auth/AudienceSwitch'

// The sign-in page: an ID badge hanging from a lanyard over ECG paper.
//
// - Page: ECG paper -- a fine and a major grid in the brand tint (static) --
//   with one slow sweep trace across the lower part (the animation).
// - Badge: brand-colour header band with a punched slot notch, the wordmark
//   (favicon mark + name), a running pulse and a STAFF / PATIENT tag; a body
//   with monospaced labels and boxed fields; a date stamp on wide screens.
// - Lanyard: woven straps and a clip above the badge that sway gently. Only
//   that decorative strap group moves (transform), never the badge.
// - Wide screens: the right side reads like the top of a clinical record,
//   with the brand-configurable quote (BRAND_LOGIN_QUOTE) set as a note.
//
// Rigid: a fixed scroll container with a stable gutter; the badge hangs from
// a fixed top offset (never centred on its content); the stamp is a fixed
// size; decoration is aria-hidden and pointer-events-none.
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
      className="fixed inset-0 overflow-y-auto overscroll-contain bg-[color-mix(in_oklch,var(--brand)_4%,var(--background))] text-foreground [scrollbar-gutter:stable] selection:bg-primary/15"
    >
      <ChartPaper />
      <div className="relative z-10 mx-auto grid min-h-dvh max-w-[1440px] gap-8 px-4 pb-10 sm:px-8 lg:grid-cols-[480px_minmax(0,1fr)] lg:gap-20 lg:px-16">
        <div className="flex flex-col items-center">
          <Lanyard />
          <article
            data-auth-panel=""
            className="auth-rise relative w-full max-w-[480px] rounded-[24px] bg-card shadow-[0_0_0_1px_color-mix(in_oklch,var(--foreground)_12%,transparent),0_1px_0_1px_rgb(255_255_255/0.6)_inset,0_2px_4px_rgb(0_0_0/0.04),0_24px_48px_-24px_rgb(0_0_0/0.28),0_60px_90px_-50px_color-mix(in_oklch,var(--brand)_45%,transparent)]"
            style={rise(0)}
          >
            <header className="relative overflow-hidden rounded-t-[24px] bg-[linear-gradient(135deg,var(--auth-panel)_0%,var(--auth-panel-deep)_100%)] px-6 pb-6 pt-9 text-[var(--auth-panel-foreground)] sm:px-8">
              {/* Punched slot notch: shows the paper through the band. */}
              <span
                aria-hidden="true"
                className="absolute left-1/2 top-3 h-3 w-[72px] -translate-x-1/2 rounded-full bg-[color-mix(in_oklch,var(--brand)_4%,var(--background))] shadow-[inset_0_1px_2px_rgb(0_0_0/0.45),0_1px_0_rgb(255_255_255/0.18)]"
              />
              <svg aria-hidden="true" className="absolute inset-x-0 bottom-0 h-12 w-full" viewBox="0 0 480 48" preserveAspectRatio="none" fill="none">
                <PulseTrace width={480} beats={2} y={28} amp={0.4} base="white" glow="var(--auth-line)" baseOpacity={0.16} glowOpacity={0.75} strokeWidth={1.5} />
              </svg>
              <div className="relative flex items-center justify-between gap-4">
                <span className="inline-flex min-w-0 items-center gap-3">
                  {logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoUrl} alt={name} className="h-10 w-auto" />
                  ) : (
                    <>
                      <BrandMark className="h-11 w-11 drop-shadow-[0_2px_6px_rgb(0_0_0/0.25)]" />
                      <span className="truncate text-xl font-semibold tracking-[-0.02em]">{name}</span>
                    </>
                  )}
                </span>
                <span className={`shrink-0 rounded-full border border-white/25 px-2.5 py-1 ${MONO_LABEL} text-[var(--auth-panel-foreground)]`}>
                  {audience === 'patient' ? 'Patient' : 'Staff'}
                </span>
              </div>
            </header>
            <div className="relative rounded-b-[24px] bg-[linear-gradient(180deg,color-mix(in_oklch,var(--brand)_3%,var(--card))_0%,var(--card)_120px)] px-6 pb-6 pt-6 sm:px-8 sm:pb-7">
              <span
                aria-hidden="true"
                data-decorative=""
                className={`absolute right-6 top-6 hidden h-10 w-[148px] -rotate-[5deg] items-center justify-center rounded-md border-[3px] border-double border-primary/70 ${MONO_LABEL} text-primary sm:flex sm:right-8`}
              >
                {date}
              </span>
              {children}
            </div>
          </article>
        </div>

        <div className="hidden pt-[clamp(96px,17vh,184px)] lg:block">
          <p className={`auth-rise ${MONO_LABEL} text-foreground/70`} style={rise(2)}>
            Record &middot; {name}
          </p>
          <figure className="auth-rise mt-5 border-y border-dashed border-foreground/25 py-10" style={rise(3)}>
            <p className={`${MONO_LABEL} text-primary`}>Note</p>
            <blockquote className="mt-5 max-w-[21ch] font-serif text-[clamp(34px,3.3vw,54px)] leading-[1.1] tracking-[-0.01em] text-foreground">
              {quote.text}
            </blockquote>
            {quote.attribution ? <figcaption className={`mt-7 ${MONO_LABEL} text-foreground/70`}>{quote.attribution}</figcaption> : null}
          </figure>
          <p className={`mt-6 ${MONO_LABEL} text-foreground/60`}>&copy; {year} {name}</p>
        </div>
        <p className={`text-center ${MONO_LABEL} text-foreground/60 lg:hidden`}>&copy; {year} {name}</p>
      </div>
    </div>
  )
}

// Two woven straps meeting at a clip. Decorative; sways a degree either side.
function Lanyard() {
  return (
    <div aria-hidden="true" data-decorative="" className="relative z-20 -mb-[18px] h-[clamp(62px,11vh,122px)] w-28 shrink-0">
      <div className="auth-sway absolute inset-0 origin-top">
        <span className="absolute bottom-3 left-[26%] top-0 w-3 -skew-x-[12deg] rounded-b-sm bg-[repeating-linear-gradient(0deg,var(--auth-panel)_0_3px,color-mix(in_oklch,var(--auth-panel)_80%,white)_3px_4px)] shadow-[1px_0_0_rgb(0_0_0/0.15)]" />
        <span className="absolute bottom-3 right-[26%] top-0 w-3 skew-x-[12deg] rounded-b-sm bg-[repeating-linear-gradient(0deg,var(--auth-panel)_0_3px,color-mix(in_oklch,var(--auth-panel)_80%,white)_3px_4px)] shadow-[-1px_0_0_rgb(0_0_0/0.15)]" />
        <span className="absolute bottom-0 left-1/2 h-5 w-9 -translate-x-1/2 rounded-t-lg border-x-[3px] border-t-[3px] border-[color-mix(in_oklch,var(--foreground)_45%,var(--background))] shadow-[0_1px_0_rgb(255_255_255/0.5)_inset]" />
      </div>
    </div>
  )
}

// ECG paper and one slow sweep trace.
function ChartPaper() {
  return (
    <div aria-hidden="true" data-decorative="" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="auth-ecg-paper absolute inset-0" />
      <svg className="absolute inset-x-0 bottom-[12%] h-[180px] w-full" viewBox="0 0 1600 180" preserveAspectRatio="none" fill="none">
        <PulseTrace width={1600} beats={5} y={100} amp={1} base="var(--brand)" glow="var(--brand)" baseOpacity={0.14} glowOpacity={0.5} strokeWidth={2} />
      </svg>
    </div>
  )
}
