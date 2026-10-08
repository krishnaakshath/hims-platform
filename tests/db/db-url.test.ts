import { describe, it, expect } from 'vitest'
import { describeDatabaseUrl, isLocalDatabaseUrl, isPooledNeonUrl, sslFor } from '@/db/url'

describe('database URL helpers', () => {
  it('treats only loopback hosts as local (no TLS)', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@127.0.0.1:54329/hims')).toBe(true)
    expect(isLocalDatabaseUrl('postgresql://u@localhost/hims')).toBe(true)
    expect(isLocalDatabaseUrl('postgres://u:p@ep-x.ap-southeast-1.aws.neon.tech/neondb?sslmode=require')).toBe(false)
    expect(isLocalDatabaseUrl(undefined)).toBe(false)
    expect(sslFor('postgres://u:p@127.0.0.1:54329/hims')).toBe(false)
    expect(sslFor('postgres://u:p@ep-x.neon.tech/db')).toEqual({ rejectUnauthorized: false })
  })

  it('recognises the Neon pooled endpoint', () => {
    expect(isPooledNeonUrl('postgres://u:p@ep-cool-name-a1b2-pooler.ap-southeast-1.aws.neon.tech/neondb')).toBe(true)
    expect(isPooledNeonUrl('postgres://u:p@ep-cool-name-a1b2.ap-southeast-1.aws.neon.tech/neondb')).toBe(false)
    expect(isPooledNeonUrl('not a url')).toBe(false)
  })

  it('describes a URL without its credentials', () => {
    const d = describeDatabaseUrl('postgres://alice:s3cret@ep-x.neon.tech:5432/neondb?sslmode=require')
    expect(d).toBe('ep-x.neon.tech:5432/neondb')
    expect(d).not.toContain('s3cret')
    expect(d).not.toContain('alice')
  })
})
