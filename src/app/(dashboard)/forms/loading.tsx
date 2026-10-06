// Skeleton for the form templates page: title + category sections, each
// with a 3-column grid of template cards (matching FormTemplateCard's
// name / diagnosis tag / question-count lines) plus the trailing "create" tile.
export default function FormsLoading() {
  return (
    <div>
      <div className="mb-6 h-7 w-52 animate-pulse rounded-md bg-muted" />
      <div className="space-y-8">
        {Array.from({ length: 2 }).map((_, sectionIndex) => (
          <section key={sectionIndex}>
            <div className="mb-3 h-3 w-28 animate-pulse rounded bg-muted" />
            <div className="grid grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, cardIndex) => (
                <div key={cardIndex} className="rounded-lg border border-border bg-card p-5">
                  <div className="mb-2 h-4 w-3/4 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
                  <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-muted" />
                </div>
              ))}
              <div className="flex items-center justify-center rounded-lg border border-dashed border-border p-5">
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
