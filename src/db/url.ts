// Connection-string helpers shared by the app's pool (src/db/client.ts) and
// the operations scripts (scripts/db/*). Nothing here ever returns the
// password or user name.

// A database on this machine has no TLS: loopback (host development and the
// test runner against the published port) and `postgres`, this repo's own
// docker-compose.yml service reached by its in-network name from the `app`,
// `migrate`, `seed`, `codes` and `test` containers (127.0.0.1 there is the
// container's own loopback). Any other host keeps TLS on.
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  return /^postgres(ql)?:\/\/[^@/]*@(localhost|127\.0\.0\.1|\[::1\]|postgres)(:\d+)?\//.test(url ?? '')
}

/** pg `ssl` option for a connection string: off locally, TLS everywhere else. */
export function sslFor(url: string | undefined): false | { rejectUnauthorized: false } {
  return isLocalDatabaseUrl(url) ? false : { rejectUnauthorized: false }
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
