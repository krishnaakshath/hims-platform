// @vitest-environment node
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { ALLOWED_UNDOCUMENTED, checkEnvDocs, documentedNames, envNamesRead, undocumentedNames } from '../../scripts/check-env-docs'

describe('envNamesRead', () => {
  it('finds process.env and env member reads, bracket reads, *_ENV constants and prefixed names', () => {
    const src = [
      "const a = process.env.SESSION_SECRET",
      "const b = env.SMTP_HOST ?? ''",
      "const c = process.env['KV_REST_API_URL']",
      "const d = env[\"NHCX_CODE_X\"]",
      "export const DEMO_FEATURES_ENV = 'DEMO_FEATURES'",
      "const keys = ['BRAND_NAME', 'ABDM_HIP_ID']",
      "const notEnv = config.SOMETHING_ELSE",
      "const lower = env.nodeEnv",
    ].join('\n')
    expect([...envNamesRead(src)].sort()).toEqual(
      ['ABDM_HIP_ID', 'BRAND_NAME', 'DEMO_FEATURES', 'KV_REST_API_URL', 'NHCX_CODE_X', 'SESSION_SECRET', 'SMTP_HOST'],
    )
  })
})

describe('documentedNames', () => {
  it('counts assigned and commented-out assignments, not prose', () => {
    const text = '# Comment about FOO\nFOO=\n# BAR=default\n  BAZ=1\n# QUX is mentioned only\n'
    expect([...documentedNames(text)].sort()).toEqual(['BAR', 'BAZ', 'FOO'])
  })
})

describe('undocumentedNames', () => {
  it('reports names neither documented nor allow-listed, sorted', () => {
    expect(undocumentedNames(['B_NEW', 'A_NEW', 'FOO', 'NODE_ENV'], new Set(['FOO']))).toEqual(['A_NEW', 'B_NEW'])
    expect(ALLOWED_UNDOCUMENTED.NODE_ENV).toBeTruthy()
  })
})

describe('the repository', () => {
  it('documents every variable src/ reads in .env.docker.example', () => {
    const { read, missing } = checkEnvDocs(path.resolve(__dirname, '../..'))
    expect(read.length).toBeGreaterThan(30)
    expect(missing).toEqual([])
  })

  it('has no cloud storage or hosting variables left in src/', () => {
    const { read } = checkEnvDocs(path.resolve(__dirname, '../..'))
    expect(read.filter((n) => /^(VERCEL_|BLOB_READ_WRITE_TOKEN|BLOB_STORE_ID|NEON_|POSTGRES_URL|EDGE_CONFIG|UPSTASH_)/.test(n))).toEqual([])
  })
})
