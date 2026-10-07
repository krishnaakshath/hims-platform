import Link from 'next/link'

// App-wide 404 (unknown URLs and every notFound() without a closer
// not-found.tsx). Brand-neutral and fixed text.
export default function NotFound() {
  return (
    <main className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-16 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you asked for does not exist, or the record has been removed.</p>
      <Link href="/" className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted">
        Go to dashboard
      </Link>
    </main>
  )
}
