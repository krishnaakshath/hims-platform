'use client'
import { useEffect, useState } from 'react'
import { useBrand } from '@/components/BrandProvider'
import { BrandMark } from '@/components/auth/BrandMark'
import { DEFAULT_LOGIN_QUOTE } from '@/lib/brand'

type MotionState = 'on' | 'paused' | 'reduce'

// 'reduce' when the user asks for reduced motion, 'paused' while the tab is
// hidden (looping decoration stops spending frames), otherwise 'on'. CSS in
// globals.css keys every sign-in animation off this attribute as well as the
// prefers-reduced-motion media query.
export function useMotionState(): MotionState {
  const [state, setState] = useState<MotionState>('on')
  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    const update = () => setState(mq?.matches ? 'reduce' : document.hidden ? 'paused' : 'on')
    update()
    mq?.addEventListener?.('change', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      mq?.removeEventListener?.('change', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return state
}

// The frame every sign-in page shares: a split screen.
//
// Left (lg+): a solid brand panel (rounded inner edge) whose box, edges and
// text never move. Its
// life comes from aria-hidden decoration INSIDE it -- a slowly breathing glow,
// concentric rings and a travelling pulse trace -- animated with
// transform/opacity/stroke-dashoffset only. Below lg the panel is a slim solid
// header bar with the same pulse trace.
//
// Right: the form column, anchored at a fixed offset from the top (never
// vertically centred on its own content), inside a fixed full-viewport scroll
// container with a stable scrollbar gutter -- so errors, MFA steps, the
// department menu or the entrance animation can never shift anything.
export function AuthShell({ children }: { children: React.ReactNode }) {
  const { name, logoUrl, loginQuote } = useBrand()
  const quote = loginQuote ?? DEFAULT_LOGIN_QUOTE
  const motion = useMotionState()
  const year = new Date().getFullYear()
  return (
    <div
      data-motion={motion}
      className="fixed inset-0 overflow-y-auto overscroll-contain bg-background text-foreground [scrollbar-gutter:stable] selection:bg-primary/15 lg:grid lg:grid-cols-[minmax(0,11fr)_minmax(0,13fr)]"
    >
      <aside
        data-auth-panel=""
        className="relative isolate flex h-16 items-center overflow-hidden bg-[var(--auth-panel)] px-5 text-[var(--auth-panel-foreground)] sm:px-8 lg:sticky lg:top-0 lg:h-dvh lg:rounded-r-[44px] lg:flex-col lg:items-start lg:justify-between lg:px-14 lg:py-14 xl:px-20 xl:py-16"
      >
        <PanelArt />
        <div className="relative z-10 flex items-center gap-3">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt={name} className="h-8 w-auto lg:h-10" />
          ) : (
            <>
              <BrandMark className="h-8 w-8 lg:h-12 lg:w-12" />
              <span className="text-[17px] font-semibold tracking-[-0.01em] lg:text-xl">{name}</span>
            </>
          )}
        </div>
        {/* Editorial statement: a care quote (brand-configurable) set large. */}
        <figure className="relative z-10 hidden max-w-[34rem] lg:block">
          <span aria-hidden="true" className="auth-rise block h-14 font-serif text-[88px] leading-none text-[var(--auth-line)]" style={{ '--i': 0 } as React.CSSProperties}>
            &ldquo;
          </span>
          <blockquote className="auth-rise text-balance text-[clamp(28px,2.35vw,42px)] font-medium leading-[1.18] tracking-[-0.02em]" style={{ '--i': 1 } as React.CSSProperties}>
            {quote.text}
          </blockquote>
          {quote.attribution ? (
            <figcaption className="auth-rise mt-8 flex items-center gap-3 text-[15px] leading-6 text-[var(--auth-panel-muted)]" style={{ '--i': 2 } as React.CSSProperties}>
              <span aria-hidden="true" className="h-px w-8 bg-[var(--auth-line)]" />
              {quote.attribution}
            </figcaption>
          ) : null}
        </figure>
      </aside>

      <div className="relative isolate flex min-h-[calc(100dvh-4rem)] flex-col bg-background lg:min-h-dvh">
        {/* A field of small medical crosses, static and faint, fading out
            behind the form. aria-hidden; never moves. */}
        <div aria-hidden="true" data-decorative="" className="auth-crosses pointer-events-none absolute inset-0 -z-10" />
        <main className="flex-1 px-5 pb-10 pt-10 sm:px-8 sm:pt-[clamp(48px,10vh,112px)] lg:px-12 lg:pt-[clamp(56px,15vh,168px)]">
          <div className="mx-auto w-full max-w-[440px]">{children}</div>
        </main>
        <footer className="px-5 pb-6 text-center text-xs leading-5 text-muted-foreground sm:px-8">
          &copy; {year} {name}
        </footer>
      </div>
    </div>
  )
}

// The one heartbeat path, reused by the panel and the mobile header bar.
const PULSE_PATH =
  'M0 60 H170 l12 -10 l10 10 H236 l10 -46 l14 92 l12 -64 l10 18 H330 l14 -12 l12 12 H600'

function PanelArt() {
  return (
    <div aria-hidden="true" data-decorative="" className="pointer-events-none absolute inset-0 -z-0">
      {/* Static depth: panel tone falling into a deeper shade. */}
      <div className="absolute inset-0 bg-[linear-gradient(160deg,var(--auth-panel)_10%,var(--auth-panel-deep)_95%)]" />
      {/* Slowly breathing glow (transform/opacity only). */}
      <div className="auth-breathe absolute -bottom-[30%] -right-[35%] h-[110%] w-[130%] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--auth-glow)_38%,transparent),transparent)]" />

      {/* Large screens: concentric rings and the pulse trace. */}
      <svg className="absolute inset-0 hidden h-full w-full lg:block" viewBox="0 0 600 900" preserveAspectRatio="xMidYMid slice" fill="none">
        <g stroke="white" strokeOpacity="0.07">
          {[90, 160, 230, 300, 370].map((r) => (
            <circle key={r} cx="470" cy="300" r={r} />
          ))}
        </g>
        <g stroke="var(--auth-line)" strokeOpacity="0.32" strokeWidth="1.25">
          <circle className="auth-ring" cx="470" cy="300" r="200" />
          <circle className="auth-ring" style={{ animationDelay: '3s' }} cx="470" cy="300" r="200" />
          <circle className="auth-ring" style={{ animationDelay: '6s' }} cx="470" cy="300" r="200" />
        </g>
        <g transform="translate(0 240)">
          <path d={PULSE_PATH} stroke="white" strokeOpacity="0.1" strokeWidth="1.5" strokeLinejoin="round" />
          <path className="auth-trace" pathLength={1} d={PULSE_PATH} stroke="var(--auth-line)" strokeOpacity="0.85" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>

      {/* Small screens: the slim header bar gets the pulse trace only. */}
      <svg className="absolute inset-y-0 right-0 h-full w-[70%] lg:hidden" viewBox="0 0 600 120" preserveAspectRatio="none" fill="none">
        <path d={PULSE_PATH} stroke="white" strokeOpacity="0.1" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path className="auth-trace" pathLength={1} d={PULSE_PATH} stroke="var(--auth-line)" strokeOpacity="0.7" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  )
}
