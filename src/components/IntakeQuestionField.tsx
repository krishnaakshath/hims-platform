'use client'

export interface IntakeQuestion {
  id: string
  label: string
  type: 'text' | 'textarea' | 'date' | 'select' | 'checkbox'
  options?: string[]
  required: boolean
}

// The single per-question renderer. The intake portal and the editor's
// read-only preview both render through this so the preview cannot drift from
// what a patient actually sees.
export function IntakeQuestionField({ question: q, value, onChange, disabled }: {
  question: IntakeQuestion
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-foreground">
        {q.label}{q.required && <span aria-hidden="true"> *</span>}
      </label>
      {q.type === 'textarea' ? (
        <textarea value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/40 focus:outline-none" rows={3} />
      ) : q.type === 'select' ? (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/40 focus:outline-none">
          <option value="">Select…</option>
          {q.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : q.type === 'checkbox' ? (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : 'false')} disabled={disabled} />
          I agree
        </label>
      ) : (
        <input type={q.type === 'date' ? 'date' : 'text'} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="w-full rounded-md border border-border px-3 py-2 text-sm focus:border-primary/40 focus:outline-none" />
      )}
    </div>
  )
}
