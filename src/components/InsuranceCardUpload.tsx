'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Upload, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp'

/**
 * Upload control for one side of the primary insurance card. Only the
 * primary card has upload columns/route support (see the schema comment on
 * `patients` -- secondary intentionally has no card columns), so this is
 * only ever rendered next to a primary card slot. Follows NoteForm's
 * canWrite-gates-the-whole-affordance pattern: a role that can't write gets
 * nothing rendered, not a disabled control.
 *
 * This control is deliberately narrow. Everything else insurance-shaped --
 * a secondary card, an EOB, an authorization letter, or even a primary card
 * that arrives by fax instead of through this control -- is received
 * through the generic Documents flow (`POST /api/documents` with an
 * `insurance_*` documentType; see docs/superpowers/specs/2026-09-29-document-insurance-assignment.md
 * §1 and §4). The two paths write independent records of independently
 * true facts -- `patients.primaryCard{Front,Back}Url` here, a `documents`
 * row there -- and are not kept in sync in either direction: filing or
 * un-filing a Documents row never touches these columns, and uploading
 * here never creates a `documents` row. That's acceptable because both
 * "which patient" and "what is it" are already fixed by this component's
 * props/route, so there's nothing generic left for this control to do.
 */
export function InsuranceCardUpload({ anonId, side, hasImage, canWrite }: { anonId: string; side: 'front' | 'back'; hasImage: boolean; canWrite: boolean }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!canWrite) return null

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setError(null)
    const formData = new FormData()
    formData.set('side', side)
    formData.set('file', file)
    const res = await fetch(`/api/patients/${anonId}/insurance-card`, { method: 'POST', body: formData })
    setUploading(false)
    if (res.ok) { router.refresh(); return }
    const body = await res.json().catch(() => null)
    setError(body?.error ?? 'Could not upload this card image.')
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {hasImage ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Upload className="h-3.5 w-3.5" aria-hidden="true" />}
        {uploading ? 'Uploading…' : hasImage ? 'Replace' : 'Upload'}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        onChange={handleFileChange}
        disabled={uploading}
        className="sr-only"
        aria-label={`Upload ${side} of primary insurance card`}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
