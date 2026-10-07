'use client'
// Shared fallback UI for the route error boundaries (app/error.tsx and the
// per-segment ones). Brand-neutral and fixed text: the error's message and
// stack are never rendered (they can carry server detail) -- only the digest,
// an opaque id that matches the server log line.
import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export function ErrorFallback({ digest, retry, homeHref, homeLabel }: {
  digest?: string
  retry: () => void
  homeHref: string
  homeLabel: string
}) {
  useEffect(() => {
    // Only the digest is logged client-side; the server already logged the cause.
    if (digest) console.error(`[error-boundary] digest ${digest}`)
  }, [digest])

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-16 text-center">
      <div role="alert" className="space-y-2">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">This page could not be loaded. Please try again; if it keeps happening, contact support.</p>
        {digest ? <p className="font-mono text-xs text-muted-foreground">Reference: {digest}</p> : null}
      </div>
      <div className="flex gap-3">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href={homeHref} className="inline-flex h-9 items-center rounded-md border border-border px-4 text-sm font-medium hover:bg-muted">
          {homeLabel}
        </Link>
      </div>
    </div>
  )
}
