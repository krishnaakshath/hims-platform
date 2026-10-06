// Skeleton for the settings page: title + the three stacked sections
// (Compliance, Classification, Signed in as) inside the same max-w-xl column.
export default function SettingsLoading() {
  return (
    <div className="max-w-xl space-y-6">
      <div className="mb-6 h-7 w-28 animate-pulse rounded-md bg-muted" />

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 h-3 w-24 animate-pulse rounded bg-muted" />
        <div className="h-4 w-56 animate-pulse rounded bg-muted" />
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 h-3 w-28 animate-pulse rounded bg-muted" />
        <div className="h-6 w-11 animate-pulse rounded-full bg-muted" />
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <div className="mb-3 h-3 w-24 animate-pulse rounded bg-muted" />
        <div className="h-4 w-40 animate-pulse rounded bg-muted" />
      </section>
    </div>
  )
}
