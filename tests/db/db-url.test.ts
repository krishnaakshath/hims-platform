import { describe, it, expect } from 'vitest'
import { describeDatabaseUrl, isLocalDatabaseUrl, sslFor } from '@/db/url'

describe('database URL helpers', () => {
  it('treats loopback hosts and the local docker-compose service as local (no TLS)', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@127.0.0.1:54329/hims')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://u@localhost/hims')).toBe(true)
    expect(isLocalDatabaseUrl('postgres://u:p@[::1]:5432/hims')).toBe(true)
    // docker-compose.yml's own `postgres` service, reached by its in-network
    // name from inside the app/migrate/test containers (127.0.0.1 there is the
    // container's own loopback, not postgres's).
    expect(isLocalDatabaseUrl('postgres://postgres:hims_local_dev@postgres:5432/hims')).toBe(true)
    expect(isLocalDatabaseUrl('postgres://postgres:x@postgres/hims_test')).toBe(true)
    expect(isLocalDatabaseUrl('postgres://u:p@db.example.com/hims?sslmode=require')).toBe(false)
    // Only the exact service name: a host that merely starts with it keeps TLS.
    expect(isLocalDatabaseUrl('postgres://u:p@postgres.example.com/hims')).toBe(false)
    expect(isLocalDatabaseUrl(undefined)).toBe(false)
    expect(sslFor('postgres://u:p@127.0.0.1:54329/hims')).toBe(false)
    expect(sslFor('postgres://u:p@postgres:5432/hims')).toBe(false)
    expect(sslFor('postgres://u:p@db.example.com/db')).toEqual({ rejectUnauthorized: false })
  })

  it('describes a URL without its credentials', () => {
    const d = describeDatabaseUrl('postgres://alice:s3cret@db.example.com:5432/hims?sslmode=require')
    expect(d).toBe('db.example.com:5432/hims')
    expect(d).not.toContain('s3cret')
    expect(d).not.toContain('alice')
  })
})
