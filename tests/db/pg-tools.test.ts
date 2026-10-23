import { describe, it, expect } from 'vitest'
import { backupFileName, pgEnvFromUrl, refuseRestoreTarget } from '../../scripts/db/pg-tools'

describe('pgEnvFromUrl', () => {
  it('turns a connection URL into libpq env vars so the password never appears in argv', () => {
    expect(pgEnvFromUrl('postgres://alice:p%40ss@db.example.com:5433/hims?sslmode=require')).toEqual({
      PGHOST: 'db.example.com',
      PGPORT: '5433',
      PGUSER: 'alice',
      PGPASSWORD: 'p@ss',
      PGDATABASE: 'hims',
      PGSSLMODE: 'require',
    })
  })

  it('uses no TLS for a local database and TLS for a hosted one without sslmode', () => {
    expect(pgEnvFromUrl('postgres://u:p@127.0.0.1:54329/hims').PGSSLMODE).toBe('disable')
    expect(pgEnvFromUrl('postgres://u:p@db.example.com/db').PGSSLMODE).toBe('require')
    expect(pgEnvFromUrl('postgres://u:p@db.example.com/db').PGPORT).toBe('5432')
  })
})

describe('backupFileName', () => {
  it('names a dump after the database and a sortable UTC timestamp', () => {
    expect(backupFileName('hims', new Date('2026-10-08T05:04:03Z'))).toBe('hims-hims-20261008T050403Z.dump')
  })
})

describe('refuseRestoreTarget', () => {
  const prod = 'postgres://u:p@prod-db.example.com/hims'
  it('refuses a missing target', () => {
    expect(refuseRestoreTarget(undefined, prod)).toMatch(/RESTORE_DATABASE_URL/)
  })
  it('refuses the live database itself (same host and database name)', () => {
    expect(refuseRestoreTarget('postgres://other:x@prod-db.example.com:5432/hims', prod)).toMatch(/same database/)
  })
  it('accepts a different database or branch', () => {
    expect(refuseRestoreTarget('postgres://u:p@drill-db.example.com/hims', prod)).toBeNull()
    expect(refuseRestoreTarget('postgres://u:p@127.0.0.1:54329/hims_restore', 'postgres://u:p@127.0.0.1:54329/hims')).toBeNull()
  })
})
