// Skeleton for the home dashboard: title, the two quick-action buttons,
// and the 2x2 grid of activity cards (Latest Forms, Pending Forms,
// Pending Classifications, Latest Account Events) rendered on the real page.
export default function DashboardLoading() {
  const cardRows = 4

  return (
    <div>
      <div className="mb-6 h-7 w-32 animate-pulse rounded-md bg-muted" />

      <div className="mb-6 flex gap-3">
        <div className="h-9 w-40 animate-pulse rounded-md bg-muted" />
        <div className="h-9 w-36 animate-pulse rounded-md bg-muted" />
      </div>

      <div className="grid grid-cols-2 gap-4">
        {Array.from({ length: 4 }).map((_, cardIndex) => (
          <section key={cardIndex} className="rounded-lg border border-border bg-card p-5">
            <div className="mb-3 h-3 w-40 animate-pulse rounded bg-muted" />
            <div className="space-y-2">
              {Array.from({ length: cardRows }).map((_, rowIndex) => (
                <div key={rowIndex} className="h-4 w-[85%] animate-pulse rounded bg-muted" style={{ opacity: 1 - rowIndex * 0.12 }} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
