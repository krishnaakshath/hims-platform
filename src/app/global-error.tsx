'use client'
// Replaces the root layout when it fails, so it renders its own document and
// gets none of globals.css: plain inline styles, brand-neutral, fixed text.
// Never renders error.message -- only the digest id.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void; reset?: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#fff', color: '#111' }}>
        <title>Something went wrong</title>
        <main style={{ maxWidth: 420, margin: '0 auto', padding: '64px 16px', textAlign: 'center' }}>
          <div role="alert">
            <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: '#555', margin: '0 0 8px' }}>The application could not be loaded. Please try again.</p>
            {error.digest ? <p style={{ fontFamily: 'monospace', fontSize: 12, color: '#555' }}>Reference: {error.digest}</p> : null}
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 16 }}>
            <button type="button" onClick={() => retry()} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #111', background: '#111', color: '#fff', cursor: 'pointer' }}>
              Try again
            </button>
            {/* A plain anchor (full reload): the router itself may be what failed. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid #ccc', color: '#111', textDecoration: 'none' }}>Go to dashboard</a>
          </div>
        </main>
      </body>
    </html>
  )
}
