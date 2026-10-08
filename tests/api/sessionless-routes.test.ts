import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'

// Every API route either authenticates a staff session (requireSession) or is
// on this list, each with its own security tests. A new unlisted route fails.
const ROOT = join(__dirname, '..', '..')
function walk(p: string): string[] {
  const abs = join(ROOT, p)
  if (statSync(abs).isFile()) return p.endsWith('route.ts') ? [p] : []
  return readdirSync(abs).flatMap((e) => walk(`${p}/${e}`))
}

// SP8 session-less routes: Scan & Share and NHCX callbacks (gateway JWTs), the cron sweep (CRON_SECRET).
export const SESSIONLESS_ROUTES = [
  'src/app/api/nhcx/callback/[...action]/route.ts', // tests/api/nhcx-callback.test.ts, tests/lib/nhcx/inbound.test.ts
  'src/app/api/abdm/api/v3/hip/patient/share/route.ts', // tests/api/abdm-share-callback.test.ts
  'src/app/api/cron/nhcx-sweep/route.ts', // tests/api/nhcx-status-cron.test.ts
  'src/app/api/webhooks/fhir-labs/route.ts', // LIS token
]
// Pre-existing public or differently-authenticated routes (login, portal, health, OAuth).
const PRE_EXISTING = [
  'src/app/api/auth/google/callback/route.ts', 'src/app/api/auth/google/start/route.ts', 'src/app/api/health/ready/route.ts', 'src/app/api/health/route.ts',
  'src/app/api/login/mfa/route.ts', 'src/app/api/login/route.ts', 'src/app/api/logout/route.ts', 'src/app/api/messages/[patientId]/route.ts',
  'src/app/api/patients/[anonId]/form-submissions/[id]/sign/route.ts',
]
const PORTAL = /^src\/app\/api\/patient-portal\//

describe('session-less API routes', () => {
  it('every route calls requireSession or is listed', () => {
    const routes = walk('src/app/api').map((p) => p.split(sep).join('/'))
    const unlisted = routes.filter((r) => !/requireSession\(/.test(readFileSync(join(ROOT, r), 'utf8')))
      .filter((r) => !SESSIONLESS_ROUTES.includes(r) && !PRE_EXISTING.includes(r) && !PORTAL.test(r))
    expect(unlisted).toEqual([])
  })
  it('the SP8 session-less routes exist and never call requireSession', () => {
    for (const r of SESSIONLESS_ROUTES.slice(0, 3)) {
      const src = readFileSync(join(ROOT, r), 'utf8')
      expect(src).not.toMatch(/requireSession\(/)
    }
  })
})
