'use client'
import { Input } from '@/components/ui/input'
import { parseHex } from '@/lib/brand-color'
import { draftPalette } from '@/components/settings/branding/BrandPreview'

// WL T8: the accent colour (spec §7 Colour). A native colour picker and a hex text field kept in
// sync, the contrast of button text in words (the page's single polite live region), and a notice
// when the colour is darkened or lightened so text on it stays readable (WCAG AA, 4.5:1).
export const ACCENT_HEX_ERROR = 'Enter the accent colour as #rgb or #rrggbb'

export function AccentField({ value, fallback, error, onChange }: {
  value: string
  fallback: string | null
  error: string | null
  onChange: (next: string) => void
}) {
  const palette = draftPalette(value, fallback)
  const pickerValue = parseHex(value) ?? parseHex(fallback ?? '') ?? '#194f81'
  const errorId = 'brand-accentColor-error'
  const hintId = 'brand-accentColor-hint'
  const verdict = palette
    ? `Text on buttons: ${palette.light.ratioText.toFixed(1)}:1, ${palette.light.ratioText >= 4.5 ? 'passes AA' : 'below AA'}`
    : 'Using the standard colour'

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="brand-accentColor-picker" className="mb-1 block text-sm font-medium">Accent colour</label>
          <input
            id="brand-accentColor-picker"
            type="color"
            value={pickerValue}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-14 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
          />
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor="brand-accentColor" className="mb-1 block text-sm font-medium">Accent colour (hex)</label>
          <Input
            id="brand-accentColor"
            value={value}
            placeholder={fallback ?? '#194f81'}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            onChange={(e) => onChange(e.target.value)}
            className="font-mono"
          />
        </div>
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">Used for buttons, links and the sign-in page. Leave blank for the standard colour.</p>
      {error && <p id={errorId} className="text-xs text-destructive">{error}</p>}
      <p aria-live="polite" className="text-sm">{verdict}</p>
      {palette?.adjustedLight && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          Adjusted for readability: buttons will use <span className="font-mono">{palette.light.primary}</span> so their text stays easy to read.
        </p>
      )}
    </div>
  )
}
