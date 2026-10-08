import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'

// SP8 static guards (plan Task 16): no console logging in integration code,
// the national ID word only where the ABDM API itself names it, the national
// ID value read once and only into encrypt(), no secret-like identifier in an
// audit call, a flow store with no ID/OTP field, mocks imported only by their
// registries, no committed key material, secrets read from env only in the
// config seam, and no client code importing the config.

const ROOT = join(__dirname, '..', '..')
function walk(p: string): string[] {
  const abs = join(ROOT, p)
  if (!existsSync(abs)) return []
  if (statSync(abs).isFile()) return /\.(ts|tsx)$/.test(abs) ? [p] : []
  return readdirSync(abs).flatMap((e) => walk(`${p}/${e}`))
}
const posix = (p: string) => p.split(sep).join('/')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')
const SRC = walk('src').map(posix)
const NATIONAL_ID = /aadhaar/i

const INTEGRATION_DIRS = ['src/lib/abdm', 'src/lib/nhcx', 'src/lib/fhir/nhcx', 'src/lib/integrations', 'src/app/api/abdm', 'src/app/api/nhcx', 'src/app/api/rcm/nhcx', 'src/app/api/cron', 'src/app/api/settings/integrations']

describe('integration secret and national ID guards (static)', () => {
  it('1. no console call in integration code (safeLog is the only sink)', () => {
    const files = INTEGRATION_DIRS.flatMap(walk).map(posix).filter((f) => f !== 'src/lib/integrations/safe-log.ts')
    expect(files.length).toBeGreaterThan(20)
    expect(files.filter((f) => /\bconsole\./.test(read(f)))).toEqual([])
  })

  it('2. the national ID word appears in ABDM code only where the ABDM API names it', () => {
    const ALLOWED = [
      'src/lib/abdm/constants.ts', // paths (enrol/byAadhaar), loginHint and enum values
      'src/lib/abdm/gateway.ts', // method names
      'src/lib/abdm/http-adapter.ts', // method names and the documented request bodies
      'src/lib/abdm/mock-adapter.ts', // method names
      'src/app/api/abdm/abha/enrol/otp/route.ts', // reads the value once, into encrypt()
      'src/app/api/abdm/abha/login/otp/route.ts', // the national-ID login route name
      'src/app/api/abdm/abha/enrol/verify/route.ts', // the enrolByAadhaarOtp method and the aadhaar_otp_enrolment enum value only
    ]
    const offenders = [...walk('src/lib/abdm'), ...walk('src/app/api/abdm')].map(posix).filter((f) => NATIONAL_ID.test(read(f)) && !ALLOWED.includes(f))
    expect(offenders).toEqual([])
    expect(NATIONAL_ID.test(read('src/lib/validation/abha-flow.ts'))).toBe(true) // the schema that validates it
  })

  it('3. the enrolment OTP route reads the national ID value once, straight into encrypt()', () => {
    const src = read('src/app/api/abdm/abha/enrol/otp/route.ts')
    const uses = src.split('\n').filter((l) => /\b(body|data)\.aadhaar\b/.test(l))
    expect(uses).toHaveLength(1)
    expect(uses[0]).toMatch(/encrypt\(/)
    expect(read('src/app/api/abdm/abha/login/otp/route.ts')).not.toMatch(/\.aadhaar\b/)
  })

  it('4. audit calls in SP8 code never interpolate a secret-like identifier', () => {
    const files = [...INTEGRATION_DIRS.flatMap(walk), ...walk('src/lib/queries')].map(posix)
      .filter((f) => /abdm|nhcx|abha|integrations/.test(f))
    const BAD = /\$\{[^}]*\b(otp|aadhaar|token|userToken|transientToken|abhaNumber|abhaAddress|mobile|policyNumber|memberId|preAuthRef|utr|payload|jwe)\b[^}]*\}/
    const offenders: string[] = []
    for (const f of files) {
      const src = read(f)
      for (const m of src.matchAll(/\b(logAudit|logGatewayEvent)\(([\s\S]*?)\)\s*(?:\n|;)/g)) if (BAD.test(m[2])) offenders.push(`${f}: ${m[0].slice(0, 80)}`)
    }
    expect(files.length).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })

  it('5. the ABHA flow store declares no national ID or OTP field', () => {
    const src = read('src/lib/abdm/flow-store.ts')
    const body = /export interface AbhaFlow \{([\s\S]*?)\n\}/.exec(src)![1]
    const props = [...body.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1])
    expect(props.length).toBeGreaterThan(5)
    expect(props.filter((p) => /aadhaar|otp/i.test(p))).toEqual([])
  })

  it('6. the mocks are imported only by their registries', () => {
    const importers = (mod: string) => SRC.filter((f) => new RegExp(`from ['"](@/lib/(abdm|nhcx)/|\\./)${mod}['"]|import\\(['"]\\./${mod}['"]\\)`).test(read(f)))
    expect(importers('mock-adapter')).toEqual(['src/lib/abdm/registry.ts'])
    for (const f of importers('mock-transport')) expect(['src/lib/abdm/registry.ts', 'src/lib/nhcx/claim-gateway.ts', 'src/lib/queries/nhcx-exchanges.ts']).toContain(f)
  })

  it('7. no tracked file contains key or certificate material', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter((f) => f && !f.startsWith('node_modules'))
    const PEM = /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----\s*[A-Za-z0-9+/=]{40,}/
    const offenders = tracked.filter((f) => { try { return existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).size < 5_000_000 && PEM.test(read(f)) } catch { return false } })
    expect(offenders).toEqual([])
  })

  it('8. integration secrets are read from the environment only in the config seam', () => {
    const SECRETS = /process\.env\.(NHCX_ENCRYPTION_PRIVATE_KEY|NHCX_PREVIOUS_ENCRYPTION_PRIVATE_KEY|ABDM_CLIENT_SECRET|INTEGRATION_PAYLOAD_KEY)\b/
    expect(SRC.filter((f) => SECRETS.test(read(f)))).toEqual(['src/lib/integrations/payload-vault.ts'])
  })

  it('9. no page or component imports the integration config, except the settings page through its overview', () => {
    const ui = SRC.filter((f) => f.startsWith('src/app/(dashboard)') || f.startsWith('src/components'))
    expect(ui.filter((f) => /from ['"]@\/lib\/integrations\/config['"]/.test(read(f)))).toEqual([])
    expect(ui.filter((f) => /from ['"]@\/lib\/integrations\/overview['"]/.test(read(f)))).toEqual(['src/app/(dashboard)/settings/integrations/page.tsx'])
    expect(SRC.filter((f) => f.startsWith('src/components') && /integrations\/(config|certs|payload-vault)/.test(read(f)))).toEqual([])
  })
})
