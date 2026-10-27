'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { brandSettingsSchema, brandValidationDetails } from '@/lib/brand-validation'
import { BRAND_LIMITS } from '@/lib/brand'
import { parseHex } from '@/lib/brand-color'
import { BRAND_EDITABLE_KEYS } from '@/lib/brand-snapshot'
import type { BrandingAdminPayload } from '@/lib/queries/brand-settings'
import { BrandPreview, EMPTY_DRAFT, type BrandDraft } from '@/components/settings/branding/BrandPreview'
import { AccentField, ACCENT_HEX_ERROR } from '@/components/settings/branding/AccentField'
import { LogoUploadSlot } from '@/components/settings/branding/LogoUploadSlot'
import { ResetBrandingDialog } from '@/components/settings/branding/ResetBrandingDialog'

// WL T8: Settings > Branding (spec §7, lane rulings R2/R6). The draft drives the live preview on
// every keystroke. Save sends the full set of 15 editable fields with the revision the screen was
// loaded at (PUT /api/settings/branding); a stale revision gets the reload message. Unsaved changes
// arm a beforeunload guard and the Back link asks first. A failed save shows an error summary that
// takes focus and links to each field; each field error is tied to its field by aria-describedby.
// Logo uploads and removals take effect immediately and are not part of the draft.

const SECTION = 'rounded-md border border-border bg-card p-5 shadow-none'
const TEXTAREA =
  'block w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none transition-colors ' +
  'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 ' +
  'aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30'

type TextKey = Exclude<keyof BrandDraft, 'loginShowDepartmentList'>
type FieldErrors = Partial<Record<keyof BrandDraft, string>>

const LABELS: Record<keyof BrandDraft, string> = {
  displayName: 'Hospital name', tagline: 'Tagline', portalName: 'Patient portal name', supportEmail: 'Support email',
  supportPhone: 'Support phone', accentColor: 'Accent colour', logoUrl: 'Logo web address', loginQuote: 'Quote',
  loginQuoteAttribution: 'Quote attribution', loginShowDepartmentList: 'Show department sign-in links',
  printHeaderText: 'Header text', printFooterText: 'Footer text', printSignatureLine: 'Signature line',
  emailSignature: 'Email signature', smsName: 'SMS sender name',
}

const CONFLICT = 'Branding was changed by someone else. Reload to see their changes.'

const fieldId = (k: keyof BrandDraft) => `brand-${k}`

function toDraft(s: BrandingAdminPayload['settings']): BrandDraft {
  const out = { ...EMPTY_DRAFT }
  for (const k of BRAND_EDITABLE_KEYS) {
    if (k === 'loginShowDepartmentList') out.loginShowDepartmentList = s.loginShowDepartmentList
    else out[k] = s[k] ?? ''
  }
  return out
}

function toBody(draft: BrandDraft, revision: number): Record<string, unknown> {
  const body: Record<string, unknown> = { revision }
  for (const k of BRAND_EDITABLE_KEYS) {
    if (k === 'loginShowDepartmentList') body[k] = draft.loginShowDepartmentList
    else body[k] = draft[k].trim() === '' ? null : draft[k]
  }
  return body
}

const sameDraft = (a: BrandDraft, b: BrandDraft) => BRAND_EDITABLE_KEYS.every((k) => a[k] === b[k])

function assetPaths(assets: BrandingAdminPayload['assets']) {
  const path = (kind: string, uploadOnly = false) => assets.find((a) => a.kind === kind && (!uploadOnly || a.source === 'upload'))?.path
  return { light: path('logo_light'), dark: path('logo_dark'), icon: path('icon_512', true) }
}

type Problem = { field: keyof BrandDraft | null; message: string }

export function BrandingForm({ initial }: { initial: BrandingAdminPayload }) {
  const [baseline, setBaseline] = useState<BrandDraft>(() => toDraft(initial.settings))
  const [draft, setDraft] = useState<BrandDraft>(baseline)
  const [revision, setRevision] = useState(initial.revision)
  const [assets, setAssets] = useState(() => assetPaths(initial.assets))
  const [problems, setProblems] = useState<Problem[]>([])
  const [conflict, setConflict] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const summaryRef = useRef<HTMLDivElement>(null)

  const dirty = !sameDraft(draft, baseline)
  const accentError = draft.accentColor.trim() !== '' && !parseHex(draft.accentColor) ? ACCENT_HEX_ERROR : null
  const errors: FieldErrors = {}
  for (const p of problems) if (p.field && !errors[p.field]) errors[p.field] = p.message
  if (accentError) errors.accentColor = accentError

  useEffect(() => {
    if (!dirty) return
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])

  useEffect(() => {
    if (problems.length > 0 || conflict) summaryRef.current?.focus()
  }, [problems, conflict])

  function set<K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }))
    setStatus(null)
    if (problems.some((p) => p.field === key)) setProblems((ps) => ps.filter((p) => p.field !== key))
  }

  async function save() {
    setStatus(null)
    setConflict(false)
    const body = toBody(draft, revision)
    const parsed = brandSettingsSchema.safeParse(body)
    if (!parsed.success) {
      setProblems(brandValidationDetails(parsed.error).map((d) => ({ field: d.field as keyof BrandDraft | null, message: d.message })))
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/settings/branding', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (res.status === 409) { setProblems([]); setConflict(true); return }
      if (!res.ok) {
        const details: Problem[] = Array.isArray(data?.details)
          ? data.details.map((d: { field: string | null; message: string }) => ({
            field: d.field && d.field in LABELS ? (d.field as keyof BrandDraft) : null, message: String(d.message),
          }))
          : []
        setProblems(details.length > 0 ? details : [{ field: null, message: typeof data?.error === 'string' ? data.error : 'Could not save the branding settings' }])
        return
      }
      setProblems([])
      setRevision(data.revision)
      setBaseline(draft)
      setStatus('Saved. Everyone sees the new branding on their next page load.')
    } catch {
      setProblems([{ field: null, message: 'Could not save. Check the connection and try again.' }])
    } finally {
      setSaving(false)
    }
  }

  function discard() {
    setDraft(baseline)
    setProblems([])
    setConflict(false)
    setStatus(null)
  }

  async function reset() {
    setResetBusy(true)
    setResetError(null)
    try {
      const res = await fetch('/api/settings/branding/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESET', revision }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setResetError(res.status === 409 ? CONFLICT : typeof data?.error === 'string' ? data.error : 'Could not reset the branding')
        return
      }
      setRevision(data.revision)
      setBaseline(EMPTY_DRAFT)
      setDraft(EMPTY_DRAFT)
      setAssets({ light: undefined, dark: undefined, icon: undefined })
      setProblems([])
      setConflict(false)
      setResetOpen(false)
      setStatus('Branding reset to defaults.')
    } catch {
      setResetError('Could not reset. Check the connection and try again.')
    } finally {
      setResetBusy(false)
    }
  }

  function describedBy(key: keyof BrandDraft, hint?: boolean): string | undefined {
    const ids = [hint ? `${fieldId(key)}-hint` : null, errors[key] ? `${fieldId(key)}-error` : null].filter(Boolean)
    return ids.length > 0 ? ids.join(' ') : undefined
  }

  function textField({ k, max, hint, placeholder, multiline, type }: {
    k: TextKey; max: number; hint?: string; placeholder?: string; multiline?: boolean; type?: string
  }) {
    const common = {
      id: fieldId(k),
      value: draft[k],
      placeholder,
      maxLength: max * 2,
      'aria-invalid': errors[k] ? true : undefined,
      'aria-describedby': describedBy(k, Boolean(hint)),
    }
    return (
      <div>
        <label htmlFor={fieldId(k)} className="mb-1 block text-sm font-medium">{LABELS[k]}</label>
        {multiline ? (
          <textarea {...common} rows={3} className={TEXTAREA} onChange={(e) => set(k, e.target.value)} />
        ) : (
          <Input {...common} type={type ?? 'text'} onChange={(e) => set(k, e.target.value)} />
        )}
        {hint && <p id={`${fieldId(k)}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        {errors[k] && <p id={`${fieldId(k)}-error`} className="mt-1 text-xs text-destructive">{errors[k]}</p>}
      </div>
    )
  }

  const d = initial.defaults
  const linked = initial.linked
  const linkedRows: [string, string | null][] = [
    ['Legal name', linked.legalName], ['Address', linked.address], ['GSTIN', linked.gstin], ['ROHINI ID', linked.rohiniId], ['HFR ID', linked.hfrId],
  ]

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a
          href="/settings"
          className="text-sm text-primary hover:underline"
          onClick={(e) => { if (dirty && !window.confirm('Leave without saving your branding changes?')) e.preventDefault() }}
        >
          Back to settings
        </a>
        {status && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{status}</p>}
      </div>

      {(problems.length > 0 || conflict) && (
        <div ref={summaryRef} role="alert" tabIndex={-1} className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-destructive/30">
          {conflict ? (
            <div className="flex flex-wrap items-center gap-3">
              <p>{CONFLICT}</p>
              <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button>
            </div>
          ) : (
            <>
              <p className="font-medium">The branding was not saved. Fix the following:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {problems.map((p, i) => (
                  <li key={i}>
                    {p.field ? <a href={`#${fieldId(p.field)}`} className="underline">{LABELS[p.field]}: {p.message}</a> : p.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
        <form
          noValidate
          className="space-y-5"
          onSubmit={(e) => { e.preventDefault(); if (dirty && !saving) void save() }}
        >
          <section id="identity" aria-labelledby="identity-h" className={SECTION}>
            <h2 id="identity-h" className="mb-3 text-base font-semibold">Identity</h2>
            <div className="space-y-3">
              {textField({ k: 'displayName', max: BRAND_LIMITS.name, placeholder: d.name, hint: 'Shown on the sign-in page, the navigation, page titles, emails and SMS.' })}
              {textField({ k: 'tagline', max: BRAND_LIMITS.tagline, placeholder: d.tagline })}
              {textField({ k: 'portalName', max: BRAND_LIMITS.portalName, placeholder: d.portalName, hint: 'What patients see the online portal called.' })}
            </div>
          </section>

          <section id="contact" aria-labelledby="contact-h" className={SECTION}>
            <h2 id="contact-h" className="mb-3 text-base font-semibold">Contact</h2>
            <div className="space-y-3">
              {textField({ k: 'supportEmail', max: BRAND_LIMITS.supportEmail, type: 'email', placeholder: d.supportEmail ?? 'help@hospital.in' })}
              {textField({ k: 'supportPhone', max: BRAND_LIMITS.supportPhone, type: 'tel', placeholder: '+91 20 4000 1234' })}
            </div>
          </section>

          <section id="logo" aria-labelledby="logo-h" className={SECTION}>
            <h2 id="logo-h" className="mb-3 text-base font-semibold">Logo and icon</h2>
            <p className="mb-3 text-sm text-muted-foreground">PNG, JPEG, WebP or SVG, up to 1 MB. Changes here are saved straight away.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <LogoUploadSlot variant="light" title="Light logo" hint="For light backgrounds. At least 64 × 16 pixels." path={assets.light ?? null}
                onChange={({ path }) => setAssets((a) => ({ ...a, light: path ?? undefined }))} />
              <LogoUploadSlot variant="dark" title="Dark logo" hint="Optional, for dark mode." path={assets.dark ?? null}
                onChange={({ path }) => setAssets((a) => ({ ...a, dark: path ?? undefined }))} />
              <LogoUploadSlot variant="icon" title="App icon" hint="Square, at least 128 × 128 pixels. Without one, the icon is made from the light logo." path={assets.icon ?? null}
                onChange={({ path }) => setAssets((a) => ({ ...a, icon: path ?? undefined }))} />
            </div>
            <div className="mt-3">
              {textField({ k: 'logoUrl', max: BRAND_LIMITS.logoUrl, placeholder: 'https://', hint: 'https:// or a path on this site; an uploaded logo takes priority' })}
            </div>
          </section>

          <section id="colour" aria-labelledby="colour-h" className={SECTION}>
            <h2 id="colour-h" className="mb-3 text-base font-semibold">Colour</h2>
            <AccentField value={draft.accentColor} fallback={d.accentColor} error={errors.accentColor ?? null} onChange={(v) => set('accentColor', v)} />
          </section>

          <section id="signin" aria-labelledby="signin-h" className={SECTION}>
            <h2 id="signin-h" className="mb-3 text-base font-semibold">Sign-in page</h2>
            <div className="space-y-3">
              {textField({ k: 'loginQuote', max: BRAND_LIMITS.loginQuote, multiline: true, hint: 'Shown beside the sign-in card on wide screens. Leave blank for the standard quote.' })}
              {textField({ k: 'loginQuoteAttribution', max: BRAND_LIMITS.loginQuoteAttribution, placeholder: 'e.g. Dr. A. Rao, Medical Director' })}
              <div className="flex items-start gap-2">
                <input
                  id={fieldId('loginShowDepartmentList')}
                  type="checkbox"
                  checked={draft.loginShowDepartmentList}
                  onChange={(e) => set('loginShowDepartmentList', e.target.checked)}
                  aria-describedby={`${fieldId('loginShowDepartmentList')}-hint`}
                  className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
                />
                <div>
                  <label htmlFor={fieldId('loginShowDepartmentList')} className="text-sm font-medium">{LABELS.loginShowDepartmentList}</label>
                  <p id={`${fieldId('loginShowDepartmentList')}-hint`} className="text-xs text-muted-foreground">
                    The &ldquo;Department sign-in&rdquo; list under the staff form. Bookmarked department addresses keep working when it is hidden.
                  </p>
                </div>
              </div>
            </div>
          </section>

          <section id="print" aria-labelledby="print-h" className={SECTION}>
            <h2 id="print-h" className="mb-3 text-base font-semibold">Printed documents</h2>
            <div className="space-y-3">
              {textField({ k: 'printHeaderText', max: BRAND_LIMITS.printHeaderText, placeholder: linked.legalName ?? d.legalName, hint: 'The first line on slips, bills and summaries. Leave blank to use the legal name.' })}
              {textField({ k: 'printFooterText', max: BRAND_LIMITS.printFooterText, placeholder: 'e.g. Get well soon. Emergency: 108' })}
              {textField({ k: 'printSignatureLine', max: BRAND_LIMITS.printSignatureLine, placeholder: 'Authorised signatory' })}
              <div className="rounded-md border border-dashed border-border p-3 text-sm">
                <p className="mb-2 font-medium">From Billing settings (read-only)</p>
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1">
                  {linkedRows.map(([label, value]) => (
                    <div key={label} className="contents">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="break-words">{value ?? <span className="text-muted-foreground">Not set</span>}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2"><a href="/billing/rules" className="text-primary hover:underline">Change these in Billing settings</a></p>
              </div>
            </div>
          </section>

          <section id="messages" aria-labelledby="messages-h" className={SECTION}>
            <h2 id="messages-h" className="mb-3 text-base font-semibold">Messages</h2>
            <div className="space-y-3">
              {textField({ k: 'emailSignature', max: BRAND_LIMITS.emailSignature, multiline: true, hint: `Added to the end of every email. Up to ${BRAND_LIMITS.emailSignatureLines} lines.` })}
              {textField({ k: 'smsName', max: BRAND_LIMITS.smsName, placeholder: d.name, hint: 'The hospital name used inside SMS text. The sender ID is set with your SMS provider.' })}
            </div>
          </section>

          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-border bg-background/95 py-3">
            <Button type="submit" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
            <Button type="button" variant="outline" disabled={!dirty || saving} onClick={discard}>Discard changes</Button>
            <span className="flex-1" />
            <Button type="button" variant="destructive" onClick={() => { setResetError(null); setResetOpen(true) }}>Reset to defaults</Button>
          </div>
        </form>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <BrandPreview
            draft={draft}
            assets={assets}
            linked={linked}
            defaults={{ name: d.name, tagline: d.tagline, portalName: d.portalName, accentColor: d.accentColor, loginQuote: d.loginQuote }}
          />
        </aside>
      </div>

      <ResetBrandingDialog open={resetOpen} busy={resetBusy} error={resetError} onOpenChange={setResetOpen} onConfirm={() => void reset()} />
    </div>
  )
}
