// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { assertSeedAllowed, seedEmail, seedEmailDomain, seedDemoPassword } from '@/db/seed'

describe('seed configuration', () => {
  it('defaults the demo domain to example.test and honours SEED_EMAIL_DOMAIN', () => {
    expect(seedEmailDomain({} as NodeJS.ProcessEnv)).toBe('example.test')
    expect(seedEmail('pi', { SEED_EMAIL_DOMAIN: 'Acme.Example.org' } as unknown as NodeJS.ProcessEnv)).toBe('pi@acme.example.org')
  })

  it('rejects a malformed domain', () => {
    expect(() => seedEmailDomain({ SEED_EMAIL_DOMAIN: 'a@b.com' } as unknown as NodeJS.ProcessEnv)).toThrow(/SEED_EMAIL_DOMAIN/)
  })

  it('requires SEED_DEMO_PASSWORD (no default, minimum length)', () => {
    expect(() => seedDemoPassword({} as NodeJS.ProcessEnv)).toThrow(/SEED_DEMO_PASSWORD/)
    expect(() => seedDemoPassword({ SEED_DEMO_PASSWORD: 'short' } as unknown as NodeJS.ProcessEnv)).toThrow(/SEED_DEMO_PASSWORD/)
    const pw = 'x'.repeat(16)
    expect(seedDemoPassword({ SEED_DEMO_PASSWORD: pw } as unknown as NodeJS.ProcessEnv)).toBe(pw)
  })

  it('refuses production unless ALLOW_PRODUCTION_SEED=1', () => {
    const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
    expect(() => assertSeedAllowed(env({ NODE_ENV: 'production' }))).toThrow(/production/)
    expect(() => assertSeedAllowed(env({ VERCEL_ENV: 'production' }))).toThrow(/production/)
    expect(() => assertSeedAllowed(env({ NODE_ENV: 'production', ALLOW_PRODUCTION_SEED: 'true' }))).toThrow(/production/)
    expect(() => assertSeedAllowed(env({ NODE_ENV: 'production', ALLOW_PRODUCTION_SEED: '1' }))).not.toThrow()
    expect(() => assertSeedAllowed(env({ NODE_ENV: 'development' }))).not.toThrow()
    expect(() => assertSeedAllowed(env({ VERCEL_ENV: 'preview' }))).not.toThrow()
  })
})

describe('no hardcoded demo credentials in source', () => {
  it('seed.ts and the portal-password route contain no fixed password literal', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    for (const f of ['src/db/seed.ts', 'src/app/api/patients/[anonId]/portal-password/route.ts']) {
      expect(readFileSync(join(__dirname, '..', '..', f), 'utf8')).not.toMatch(/Pressword/i)
    }
  })
})
