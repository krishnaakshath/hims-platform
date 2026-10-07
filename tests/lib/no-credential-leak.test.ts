import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Static guard: the credential columns on `patients` (portal password hash,
// encrypted TOTP secret) never ride along in a whole-row read. Every read of
// patients either lists its columns or uses `publicPatientColumns` from
// src/lib/queries/patient-columns.ts (which omits them), so no route JSON,
// cache payload, export, FHIR/C-CDA, search or report row can carry them.
// Runtime half: tests/lib/queries/patient-read-model.test.ts.

const ROOT = join(__dirname, '..', '..')
function walk(p: string): string[] {
  const abs = join(ROOT, p)
  if (statSync(abs).isFile()) return /\.(ts|tsx)$/.test(abs) ? [p] : []
  return readdirSync(abs).flatMap((e) => walk(`${p}/${e}`))
}
const SRC = walk('src')
const code = (f: string) => readFileSync(join(ROOT, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
const filesMatching = (re: RegExp) => SRC.filter((f) => re.test(code(f))).sort()

describe('no patient credential leak (static)', () => {
  it('no whole-row select of patients anywhere in src', () => {
    expect(filesMatching(/select\(\s*\)\s*\.from\(\s*patients\b/)).toEqual([])
    expect(filesMatching(/:\s*patients\s*[,}]/)).toEqual([]) // { patient: patients } nested whole row
    expect(filesMatching(/getTableColumns\(\s*patients\s*\)/)).toEqual(['src/lib/queries/patient-columns.ts'])
    expect(filesMatching(/query\.patients\b/)).toEqual([])
    expect(filesMatching(/\.returning\(\s*\)/).filter((f) => /(insert|update)\(\s*patients\b[^;]*?\.returning\(\s*\)/.test(code(f)))).toEqual(['src/db/seed.ts']) // CLI seeding script, never served
  })

  it('portalPasswordHash is named only by the schema, the column helper and the portal credential functions', () => {
    expect(filesMatching(/portalPasswordHash/)).toEqual([
      'src/db/schema.ts',
      'src/lib/queries/patient-columns.ts',
      'src/lib/queries/patient-portal.ts', // verify/set/revoke + login candidate, server-side only
    ])
  })

  it('patients.mfaSecretEncrypted is read only by the portal MFA state functions', () => {
    expect(filesMatching(/patients\.mfaSecretEncrypted/)).toEqual(['src/lib/queries/patient-portal.ts'])
  })

  it('the old ad-hoc strip helper is gone (one shared place)', () => {
    expect(filesMatching(/withoutMfaSecret/)).toEqual([])
  })
})
