'use client'
import { useState, type CSSProperties } from 'react'
import { DEFAULT_LOGIN_QUOTE, DEFAULT_PORTAL_NAME, DEFAULT_TAGLINE, parseLogoUrl, type LoginQuote } from '@/lib/brand'
import { deriveAccentPalette, parseHex, type AccentPalette } from '@/lib/brand-color'
import { PLUS_BAR, PLUS_LENGTH, PLUS_RADIUS, PULSE_PATH, PULSE_STROKE } from '@/lib/brand-icon'
import type { BrandEditableKey } from '@/lib/brand-snapshot'
import { MONO_LABEL } from '@/components/auth/auth-styles'

// WL T8: the Settings > Branding live preview (spec §7, lane ruling R2). Four static panes drawn
// from the unsaved draft: the sign-in badge, the navigation header, an 80 mm slip header and an
// email. Static markup only: it mirrors the ID-badge login (ShellChart) but never mounts it, its
// lanyard, its pulse traces or any animation. Every value is rendered by React as text. The accent
// reaches the panes only as inline CSS variables on the preview's own container, and only from a
// validated hex (deriveAccentPalette output); an invalid entry keeps the last valid colour.

type TextKey = Exclude<BrandEditableKey, 'loginShowDepartmentList'>
/** The editable brand fields as the form holds them: '' means "use the default". */
export type BrandDraft = { [K in TextKey]: string } & { loginShowDepartmentList: boolean }

export const EMPTY_DRAFT: BrandDraft = {
  displayName: '', tagline: '', supportEmail: '', supportPhone: '', accentColor: '', logoUrl: '', loginQuote: '',
  loginQuoteAttribution: '', loginShowDepartmentList: true, portalName: '', printHeaderText: '', printFooterText: '',
  printSignatureLine: '', emailSignature: '', smsName: '',
}

export interface BrandPreviewDefaults { name: string; tagline: string; portalName: string; accentColor: string | null; loginQuote?: LoginQuote }
export interface BrandPreviewLinked { legalName: string | null; address: string | null; gstin: string | null; rohiniId: string | null; hfrId: string | null }

const FALLBACK_DEFAULTS: BrandPreviewDefaults = { name: 'HIMS', tagline: DEFAULT_TAGLINE, portalName: DEFAULT_PORTAL_NAME, accentColor: null }

const pick = (v: string, fallback: string): string => (v.trim() === '' ? fallback : v.trim())

/** The palette for an accent entry: blank uses the default accent (or none); invalid is `undefined`. */
export function draftPalette(accent: string, fallback: string | null): AccentPalette | null | undefined {
  const raw = accent.trim() === '' ? fallback : accent
  if (!raw) return null
  const hex = parseHex(raw)
  return hex ? deriveAccentPalette(hex) : undefined
}

function paletteStyle(p: AccentPalette | null): CSSProperties | undefined {
  if (!p) return undefined
  return {
    '--brand': p.input, '--primary': p.light.primary, '--primary-foreground': p.light.foreground, '--ring': p.light.primary,
  } as CSSProperties
}

/** The favicon mark, drawn statically (no .auth-draw): BrandMark without its sign-in animation. */
function StaticMark({ className }: { className: string }) {
  const c = 16
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={`shrink-0 ${className}`}>
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <rect x={c - PLUS_BAR / 2} y={c - PLUS_LENGTH / 2} width={PLUS_BAR} height={PLUS_LENGTH} rx={PLUS_RADIUS} fill="white" />
      <rect x={c - PLUS_LENGTH / 2} y={c - PLUS_BAR / 2} width={PLUS_LENGTH} height={PLUS_BAR} rx={PLUS_RADIUS} fill="white" />
      <path d={PULSE_PATH} fill="none" stroke="var(--brand)" strokeWidth={PULSE_STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Wordmark({ name, logo, markClass, textClass }: { name: string; logo: string | null; markClass: string; textClass: string }) {
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo} alt={name} className="h-8 w-auto max-w-[180px] object-contain" />
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <StaticMark className={markClass} />
      <span className={`truncate ${textClass}`}>{name}</span>
    </span>
  )
}

function Pane({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div data-pane={id} className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  )
}

export function BrandPreview({ draft, assets, linked, defaults = FALLBACK_DEFAULTS }: {
  draft: BrandDraft
  assets: { light?: string; dark?: string; icon?: string }
  linked: BrandPreviewLinked
  defaults?: BrandPreviewDefaults
}) {
  // Keep the last valid palette while the hex field holds an invalid entry (state-from-props pattern).
  const current = draftPalette(draft.accentColor, defaults.accentColor)
  const [lastValid, setLastValid] = useState<AccentPalette | null>(current ?? null)
  if (current !== undefined && current?.input !== lastValid?.input) setLastValid(current)
  const palette = current === undefined ? lastValid : current

  const name = pick(draft.displayName, defaults.name)
  const tagline = pick(draft.tagline, defaults.tagline)
  const portal = pick(draft.portalName, defaults.portalName)
  const logo = assets.light ?? (draft.logoUrl.trim() ? parseLogoUrl(draft.logoUrl) : null)
  // Quote resolution mirrors resolveBrand: a stored quote brings its own attribution, never mixed with the default.
  const quote = draft.loginQuote.trim()
    ? { text: draft.loginQuote.trim(), attribution: draft.loginQuoteAttribution.trim() || null }
    : defaults.loginQuote ?? DEFAULT_LOGIN_QUOTE
  const header = pick(draft.printHeaderText, linked.legalName?.trim() || name)
  const signature = draft.emailSignature.trim() ? draft.emailSignature.trim() : `${name}`
  const smsName = pick(draft.smsName, name)
  const contact = [draft.supportPhone.trim(), draft.supportEmail.trim()].filter(Boolean).join(' · ')

  return (
    <div inert aria-label="Preview" className="space-y-4 rounded-md border border-border bg-background p-4" style={paletteStyle(palette)}>
      <Pane id="signin" label="Sign-in page">
        <div className="rounded-lg bg-[linear-gradient(180deg,color-mix(in_oklch,var(--brand)_8%,var(--background))_0%,var(--background)_100%)] p-3">
          <div className="overflow-hidden rounded-[14px] bg-card shadow-[0_0_0_1px_color-mix(in_oklch,var(--foreground)_12%,transparent),0_12px_24px_-16px_rgb(0_0_0/0.3)]">
            <div className="flex items-center justify-between gap-2 bg-[linear-gradient(135deg,var(--auth-panel)_0%,var(--auth-panel-deep)_100%)] px-4 py-3 text-[var(--auth-panel-foreground)]">
              <Wordmark name={name} logo={logo} markClass="h-7 w-7" textClass="text-sm font-semibold" />
              <span className={`shrink-0 rounded-full border border-white/25 px-2 py-0.5 text-[10px] ${MONO_LABEL}`}>Staff</span>
            </div>
            <div className="space-y-2 px-4 py-3">
              <p className="text-base font-semibold leading-6">Sign in</p>
              <div className="h-7 rounded-md border border-foreground/20" />
              <div className="flex h-7 items-center justify-center rounded-md bg-primary text-[11px] font-semibold uppercase tracking-[0.12em] text-primary-foreground">Sign in</div>
              {draft.loginShowDepartmentList && (
                <p className={`border-t border-dashed border-foreground/20 pt-2 text-[11px] ${MONO_LABEL} text-foreground/75`}>Department sign-in</p>
              )}
            </div>
          </div>
          <figure className="mt-3 border-l-2 border-primary/60 pl-3">
            <blockquote className="text-sm leading-5 text-foreground">&ldquo;{quote.text}&rdquo;</blockquote>
            {quote.attribution && <figcaption className="mt-1 text-xs text-muted-foreground">{quote.attribution}</figcaption>}
          </figure>
        </div>
      </Pane>

      <Pane id="nav" label="Navigation">
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2">
          <Wordmark name={name} logo={logo} markClass="h-6 w-6" textClass="text-sm font-semibold" />
          <span className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground">New visit</span>
        </div>
        <p className="text-xs text-muted-foreground">{tagline} · Patients sign in to the {portal}</p>
      </Pane>

      <Pane id="slip" label="Printed slip">
        <div className="mx-auto w-[240px] rounded-sm border border-border bg-white p-3 font-mono text-[11px] leading-4 text-black">
          <p className="text-center text-xs font-bold">{header}</p>
          {linked.address && <p className="text-center">{linked.address}</p>}
          {linked.gstin && <p className="text-center">GSTIN {linked.gstin}</p>}
          {contact && <p className="text-center">{contact}</p>}
          <p className="my-1 border-t border-dashed border-black/50" />
          <p>OPD token 14 · Dr. S. Iyer</p>
          {draft.printSignatureLine.trim() && <p className="mt-3 text-right">{draft.printSignatureLine.trim()}</p>}
          {draft.printFooterText.trim() && <p className="mt-1 border-t border-dashed border-black/50 pt-1 text-center">{draft.printFooterText.trim()}</p>}
        </div>
      </Pane>

      <Pane id="email" label="Email">
        <div className="space-y-1 rounded-md border border-border bg-card px-3 py-2 text-xs leading-5">
          <p className="font-semibold">Your {name} sign-in code</p>
          <p>Your one-time code is 482913. It expires in 10 minutes.</p>
          <p className="whitespace-pre-line text-muted-foreground">{signature}</p>
          <p className="border-t border-border pt-1 text-muted-foreground">SMS sender name: {smsName}</p>
        </div>
      </Pane>
    </div>
  )
}
