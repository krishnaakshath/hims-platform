'use client'
import { useBrand } from '@/components/BrandProvider'
import { BrandMark } from '@/components/auth/BrandMark'
import { PulseTrace, useGreeting, useLoginQuote, useMotionState } from '@/components/auth/auth-common'
import { rise } from '@/components/auth/auth-styles'

// DESIGN C -- minimal typographic. No card and no panel: the hospital name
// set as an oversized wordmark, a time-of-day greeting, borderless underlined
// fields (one line on wide screens), and the animation as a slow band along
// the bottom edge with the pulse running through it. The department picker is
// a command palette ("/" opens it).
//
// Rigid: fixed scroll container with a stable gutter; content is top-anchored;
// the band is a fixed-height strip at the bottom of a min-height column.
export function ShellType({ children, switcher }: { children: React.ReactNode; switcher: React.ReactNode }) {
  const { name } = useBrand()
  const quote = useLoginQuote()
  const greeting = useGreeting()
  const motion = useMotionState()
  const year = new Date().getFullYear()
  // Long hospital names step down so the wordmark never overflows.
  const size = name.length <= 8 ? 'text-[clamp(72px,14vw,220px)]' : name.length <= 18 ? 'text-[clamp(52px,8.5vw,148px)]' : 'text-[clamp(40px,5.6vw,96px)]'
  return (
    <div
      data-motion={motion}
      data-design="c"
      className="fixed inset-0 overflow-y-auto overscroll-contain bg-background text-foreground [scrollbar-gutter:stable] selection:bg-primary/15"
    >
      <div className="relative mx-auto flex min-h-dvh max-w-[1440px] flex-col">
        <header data-auth-panel="" className="flex h-20 shrink-0 items-center justify-between gap-6 px-5 sm:px-10 lg:px-16">
          <BrandMark className="h-9 w-9" />
          {quote.text ? (
            <p className="hidden max-w-[420px] text-right text-sm leading-6 text-muted-foreground md:block">
              {quote.text}
              {quote.attribution ? <span className="text-foreground/70"> &mdash; {quote.attribution}</span> : null}
            </p>
          ) : null}
        </header>

        <main className="flex-1 px-5 pb-16 pt-[clamp(24px,7vh,88px)] sm:px-10 lg:px-16">
          <p
            aria-hidden="true"
            className={`auth-rise break-words font-semibold leading-[0.86] tracking-[-0.055em] text-foreground ${size}`}
            style={rise(0)}
          >
            {name}
            <span className="text-primary">.</span>
          </p>
          <div className="auth-rise mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 sm:mt-8" style={rise(1)}>
            <p className="text-[clamp(22px,2.4vw,34px)] font-medium leading-tight tracking-[-0.02em] text-muted-foreground">
              <span className="text-foreground">{greeting}.</span> Sign in as
            </p>
            {switcher}
          </div>
          <div className="mt-10 max-w-[1040px] sm:mt-14">{children}</div>
        </main>

        <footer className="relative h-[120px] shrink-0 overflow-hidden">
          <div aria-hidden="true" data-decorative="" className="auth-band absolute inset-0 opacity-95" />
          <svg aria-hidden="true" data-decorative="" className="absolute inset-0 h-full w-full" viewBox="0 0 1600 120" preserveAspectRatio="none" fill="none">
            <PulseTrace width={1600} beats={6} y={64} amp={0.6} base="white" glow="white" baseOpacity={0.22} glowOpacity={0.9} strokeWidth={2} />
          </svg>
          <p className="absolute bottom-4 left-5 text-xs text-white/85 sm:left-10 lg:left-16">&copy; {year} {name}</p>
        </footer>
      </div>
    </div>
  )
}
