// Helpers shared by scripts/db/backup.ts and scripts/db/restore-check.ts.
import { spawnSync } from 'node:child_process'
import { isLocalDatabaseUrl } from '../../src/db/url'

/** libpq environment for a connection URL, so the password is never on a command line. */
export function pgEnvFromUrl(url: string): Record<string, string> {
  const u = new URL(url)
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, '')),
    PGSSLMODE: u.searchParams.get('sslmode') ?? (isLocalDatabaseUrl(url) ? 'disable' : 'require'),
  }
}

export function backupFileName(database: string, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `hims-${database}-${stamp}.dump`
}

/** Why a restore target is unsafe, or null if it is acceptable. */
export function refuseRestoreTarget(target: string | undefined, live: string | undefined): string | null {
  if (!target) return 'Set RESTORE_DATABASE_URL to an EMPTY scratch database (e.g. a hims_restore_check database in the compose postgres service). It is never the live DATABASE_URL.'
  if (live) {
    const a = new URL(target)
    const b = new URL(live)
    if (a.hostname === b.hostname && (a.port || '5432') === (b.port || '5432') && a.pathname === b.pathname) {
      return 'RESTORE_DATABASE_URL is the same database as DATABASE_URL. A restore drill must never touch the live database.'
    }
  }
  return null
}

/** The pg client tool to run (PG_BIN_DIR overrides PATH), or null when it is not installed. */
export function findPgTool(name: 'pg_dump' | 'pg_restore' | 'psql'): { bin: string; version: string } | null {
  const bin = process.env.PG_BIN_DIR ? `${process.env.PG_BIN_DIR.replace(/\/$/, '')}/${name}` : name
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  return { bin, version: r.stdout.trim() }
}

export const INSTALL_HELP = `PostgreSQL client tools (pg_dump, pg_restore) are not installed or not on PATH.
The app image ships them (run inside it: docker compose exec app npm run db:backup), or use
docker compose exec postgres pg_dump ... directly. On a host, install a version at least as new
as the server (the compose postgres service runs PostgreSQL 15):
  macOS:   brew install libpq && export PATH="$(brew --prefix libpq)/bin:$PATH"
  Debian:  sudo apt-get install postgresql-client
or point PG_BIN_DIR at the directory that holds them. See docs/OPERATIONS.md.`
