// Connection-string helpers shared by the app's pool (src/db/client.ts) and
// the operations scripts (scripts/db/*). Nothing here ever returns the
// password or user name.

// A database on this machine (local Postgres for development/CI) has no TLS;
// every hosted database (Neon etc.) does.
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  return /^postgres(ql)?:\/\/[^@/]*@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(url ?? '')
}

/** pg `ssl` option for a connection string: off locally, TLS everywhere else. */
export function sslFor(url: string | undefined): false | { rejectUnauthorized: false } {
  return isLocalDatabaseUrl(url) ? false : { rejectUnauthorized: false }
}

// Neon's pooled endpoint (PgBouncer, transaction mode) has "-pooler" in the
// first host label. Session-level advisory locks and multi-statement files
// with their own BEGIN/COMMIT are not safe through it, so migrations and
// dumps use the direct endpoint (DATABASE_URL_UNPOOLED on Vercel).
export function isPooledNeonUrl(url: string | undefined): boolean {
  try {
    return new URL(url ?? '').hostname.split('.')[0].endsWith('-pooler')
  } catch {
    return false
  }
}

/** "host:port/dbname" for log lines; never the credentials. */
export function describeDatabaseUrl(url: string | undefined): string {
  try {
    const u = new URL(url ?? '')
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`
  } catch {
    return '(unparseable database URL)'
  }
}
