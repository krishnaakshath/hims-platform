// SP7: small shared form pieces for the RCM screens.
export const inputClass = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm'
export const buttonClass = 'rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50'
export const secondaryButtonClass = 'rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50'

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-muted-foreground">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  )
}

export function FormError({ error, items }: { error: string | null; items?: { code: string; message: string }[] }) {
  if (!error) return null
  return (
    <div role="alert" className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
      <p>{error}</p>
      {items && items.length > 0 && <ul className="mt-1 list-disc pl-4">{items.map((i) => <li key={`${i.code}-${i.message}`}>{i.message}</li>)}</ul>}
    </div>
  )
}

export function Panel({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{title}</h2>{actions}</div>
      {children}
    </section>
  )
}
