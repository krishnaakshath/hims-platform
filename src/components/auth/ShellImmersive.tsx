'use client'
import { useBrand } from '@/components/BrandProvider'
import { PulseTrace, Wordmark, useLoginQuote, useMotionState } from '@/components/auth/auth-common'
import { rise } from '@/components/auth/auth-styles'

// DESIGN A -- immersive. The brand field and its vitals animation fill the
// whole viewport; a huge editorial quote sits top-right; the sign-in is a
// compact glass panel pinned to the bottom-left.
//
// Rigid: the page is a fixed scroll container (stable gutter). On wide
// screens the glass panel has a reserved minimum height and sits at the
// bottom of a full-height grid row, so its top edge does not move when an
// error appears; the backdrop is a fixed aria-hidden layer whose box never
// changes (only strokes/opacity animate inside it).
export function ShellImmersive({ children }: { children: React.ReactNode }) {
  const { name } = useBrand()
  const quote = useLoginQuote()
  const motion = useMotionState()
  const year = new Date().getFullYear()
  return (
    <div
      data-motion={motion}
      data-design="a"
      className="fixed inset-0 overflow-y-auto overscroll-contain bg-[var(--auth-panel-deep)] text-white [scrollbar-gutter:stable] selection:bg-white/25"
    >
      <ImmersiveArt />
      <div className="relative z-10 mx-auto flex min-h-dvh max-w-[1680px] flex-col px-5 sm:px-8 lg:px-14">
        <header data-auth-panel="" className="flex h-20 shrink-0 items-center justify-between">
          <Wordmark markClassName="h-9 w-9" nameClassName="text-lg font-semibold tracking-[-0.015em] text-white" />
          <span className="hidden text-xs text-white/60 sm:block">&copy; {year} {name}</span>
        </header>

        <div className="grid flex-1 gap-10 pb-6 pt-4 lg:grid-cols-[440px_minmax(0,1fr)] lg:gap-16 lg:pb-12 lg:pt-6">
          <figure className="lg:order-2 lg:max-w-[min(100%,46rem)] lg:justify-self-end lg:pt-[4vh] lg:text-right">
            <blockquote
              className="auth-rise text-balance text-[clamp(30px,4.4vw,76px)] font-semibold leading-[1.02] tracking-[-0.035em] text-white"
              style={rise(0)}
            >
              {quote.text}
            </blockquote>
            {quote.attribution ? (
              <figcaption className="auth-rise mt-6 inline-flex items-center gap-3 text-sm text-white/70 lg:mt-10 lg:text-base" style={rise(1)}>
                <span aria-hidden="true" className="h-px w-10 bg-[var(--auth-line)]" />
                {quote.attribution}
              </figcaption>
            ) : null}
          </figure>

          <section aria-label="Sign in" className="lg:order-1 lg:self-end">
            <div className="auth-rise rounded-[28px] border border-white/12 bg-white/[0.06] p-6 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.65)] backdrop-blur-2xl sm:p-8 lg:min-h-[560px]" style={rise(1)}>
              {children}
            </div>
          </section>
        </div>
        <p className="pb-6 text-center text-xs text-white/60 sm:hidden">&copy; {year} {name}</p>
      </div>
    </div>
  )
}

function ImmersiveArt() {
  return (
    <div aria-hidden="true" data-decorative="" className="pointer-events-none fixed inset-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_80%_20%,var(--auth-panel)_0%,var(--auth-panel-deep)_60%)]" />
      <div className="auth-breathe absolute -right-[10%] top-[5%] h-[90vmax] w-[90vmax] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--auth-glow)_30%,transparent),transparent)]" />
      <div className="auth-breathe absolute -bottom-[40%] -left-[20%] h-[80vmax] w-[80vmax] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--brand)_45%,transparent),transparent)]" style={{ animationDelay: '-7s' }} />
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice" fill="none">
        <g stroke="white" strokeOpacity="0.06">
          {[140, 240, 340, 440, 540, 640].map((r) => (
            <circle key={r} cx="1180" cy="640" r={r} />
          ))}
        </g>
        <g stroke="var(--auth-line)" strokeOpacity="0.28" strokeWidth="1.25">
          <circle className="auth-ring" cx="1180" cy="640" r="320" />
          <circle className="auth-ring" style={{ animationDelay: '3s' }} cx="1180" cy="640" r="320" />
          <circle className="auth-ring" style={{ animationDelay: '6s' }} cx="1180" cy="640" r="320" />
        </g>
        <PulseTrace width={1600} beats={4} y={640} amp={1.3} base="white" glow="var(--auth-line)" baseOpacity={0.12} glowOpacity={0.8} strokeWidth={2.25} />
      </svg>
      {/* Legibility: deepen the bottom-left behind the glass panel. */}
      <div className="absolute inset-0 bg-[linear-gradient(20deg,color-mix(in_oklch,var(--auth-panel-deep)_80%,transparent)_10%,transparent_55%)]" />
    </div>
  )
}
