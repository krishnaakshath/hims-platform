// Skeleton for the trials list: title + a vertically stacked list of
// trial cards, each showing a name line and a metadata line (NCT · condition · site).
export default function TrialsLoading() {
  return (
    <div>
      <div className="mb-6 h-7 w-48 animate-pulse rounded-md bg-muted" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-5">
            <div className="h-4 w-64 animate-pulse rounded bg-muted" />
            <div className="mt-2 h-3 w-80 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
