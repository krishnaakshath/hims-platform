'use client'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

// WL T8: one logo or icon upload slot (spec §7 Logo and icon). Uploads go straight to
// POST /api/settings/branding/assets as multipart (file + variant); Remove calls DELETE. The
// server re-encodes every image to PNG and answers with a hash-addressed /branding path only.
export type UploadVariant = 'light' | 'dark' | 'icon'

const SVG_UNSAFE = 'This SVG contains scripts or external links. Export a plain SVG or PNG.'

export function LogoUploadSlot({ variant, title, hint, path, onChange }: {
  variant: UploadVariant
  /** e.g. "Light logo"; used for the thumbnail alt text and the control labels. */
  title: string
  hint: string
  path: string | null
  onChange: (next: { path: string | null }) => void
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const noun = title.toLowerCase()

  async function upload(file: File) {
    setBusy(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('variant', variant)
      form.append('file', file)
      const res = await fetch('/api/settings/branding/assets', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.code === 'svg_unsafe' ? SVG_UNSAFE : typeof data?.error === 'string' ? data.error : 'Could not upload the image')
        return
      }
      onChange({ path: data.asset?.path ?? null })
    } catch {
      setError('Could not upload the image. Check the connection and try again.')
    } finally {
      setBusy(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/settings/branding/assets?variant=${variant}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(typeof data?.error === 'string' ? data.error : 'Could not remove the image')
        return
      }
      onChange({ path: null })
    } catch {
      setError('Could not remove the image. Check the connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{title}</p>
      <div className="flex h-16 items-center justify-center rounded-md bg-muted/40">
        {path ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={path} alt={title} className="max-h-14 max-w-full object-contain" />
        ) : (
          <span className="text-xs text-muted-foreground">Not set</span>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-file`} className="sr-only">Upload {noun}</label>
        <input
          ref={inputRef}
          id={`${id}-file`}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          disabled={busy}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }}
          className="block w-full text-xs file:mr-2 file:rounded-md file:border file:border-input file:bg-background file:px-2 file:py-1 file:text-xs"
        />
        {path && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void remove()} aria-label={`Remove ${noun}`}>
            Remove
          </Button>
        )}
      </div>
      {busy && <p className="text-xs text-muted-foreground" role="status">Working…</p>}
      {error && <p id={`${id}-error`} className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
