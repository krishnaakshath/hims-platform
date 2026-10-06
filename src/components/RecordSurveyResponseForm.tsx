'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function RecordSurveyResponseForm({ reviewId }: { reviewId: number }) {
  const router = useRouter()
  const [ratingOverall, setRatingOverall] = useState(5)
  const [ratingFormsClarity, setRatingFormsClarity] = useState(5)
  const [ratingCommunication, setRatingCommunication] = useState(5)
  const [comments, setComments] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    const res = await fetch(`/api/reviews/${reviewId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ratingOverall, ratingFormsClarity, ratingCommunication, comments: comments || undefined }),
    })
    setSaving(false)
    if (res.ok) {
      router.refresh()
    } else {
      const body = await res.json()
      setError(body.error ?? 'Could not record this response.')
    }
  }

  function ratingField(id: string, label: string, value: number, onChange: (v: number) => void) {
    return (
      <div>
        <p id={`${id}-label`} className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
        <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              onClick={() => onChange(n)}
              className={`flex h-9 w-9 items-center justify-center rounded-md border text-sm font-semibold transition-colors ${
                value === n ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:border-primary/30 hover:text-foreground'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {ratingField('rating-overall', 'Overall Experience (1-5)', ratingOverall, setRatingOverall)}
      {ratingField('rating-forms-clarity', 'Forms Were Clear (1-5)', ratingFormsClarity, setRatingFormsClarity)}
      {ratingField('rating-communication', 'Communication Was Easy (1-5)', ratingCommunication, setRatingCommunication)}
      <div>
        <label htmlFor="survey-comments" className="mb-1 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Comments</label>
        <textarea
          id="survey-comments"
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          rows={3}
          placeholder="Any additional feedback from the patient…"
          className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      <button onClick={save} disabled={saving} className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50">
        {saving ? 'Saving…' : 'Record Response'}
      </button>
    </div>
  )
}
