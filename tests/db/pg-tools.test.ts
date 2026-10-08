import { describe, it, expect } from 'vitest'
import { backupFileName, pgEnvFromUrl, refuseRestoreTarget } from '../../scripts/db/pg-tools'

describe('pgEnvFromUrl', () => {
  it('turns a connection URL into libpq env vars so the password never appears in argv', () => {
    expect(pgEnvFromUrl('postgres://alice:p%40ss@ep-x.neon.tech:5433/neondb?sslmode=require')).toEqual({
      PGHOST: 'ep-x.neon.tech',
      PGPORT: '5433',
      PGUSER: 'alice',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'neondb',
      PGSSLMODE: 'require',
    })
  })

  it('uses no TLS for a local database and TLS for a hosted one without sslmode', () => {
    expect(pgEnvFromUrl('postgres://u:p@127.0.0.1:54329/hims').PGSSLMODE).toBe('disable')
    expect(pgEnvFromUrl('postgres://u:p@ep-x.neon.tech/db').PGSSLMODE).toBe('require')
    expect(pgEnvFromUrl('postgres://u:p@ep-x.neon.tech/db').PGPORT).toBe('5432')
  })
})

describe('backupFileName', () => {
  it('names a dump after the database and a sortable UTC timestamp', () => {
    expect(backupFileName('neondb', new Date('2026-10-08T05:04:03Z'))).toBe('hims-neondb-20261008T050403Z.dump')
  })
})

describe('refuseRestoreTarget', () => {
  const prod = 'postgres://u:p@ep-prod.neon.tech/neondb'
  it('refuses a missing target', () => {
    expect(refuseRestoreTarget(undefined, prod)).toMatch(/RESTORE_DATABASE_URL/)
  })
  it('refuses the live database itself (same host and database name)', () => {
    expect(refuseRestoreTarget('postgres://other:x@ep-prod.neon.tech:5432/neondb', prod)).toMatch(/same database/)
  })
  it('accepts a different database or branch', () => {
    expect(refuseRestoreTarget('postgres://u:p@ep-drill-branch.neon.tech/neondb', prod)).toBeNull()
    expect(refuseRestoreTarget('postgres://u:p@127.0.0.1:54329/hims_restore', 'postgres://u:p@127.0.0.1:54329/hims')).toBeNull()
  })
})
