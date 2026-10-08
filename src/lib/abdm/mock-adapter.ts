import { createHash } from 'node:crypto'
import { CAPABILITY_LABEL } from '@/lib/integrations/config'
import { isValidAbhaAddress, isValidAbhaNumber, normalizeAbhaNumber } from '@/lib/india/abha'
import type { AbdmGateway, AbdmResult, AbhaProfileView } from './gateway'

// The labelled ABDM sandbox mock (ruling 1). Reachable only through
// registry.ts when mocksEnabled() is true (ABDM_USE_MOCKS=1 outside
// production), and every row it produces is flagged abdm_sandbox_mock.
//
// Deterministic and stateless: `encrypt` returns `mock:` + sha256 of the
// value, so the mock checks an OTP by comparing hashes and never holds the
// plaintext. The only OTP it accepts is 123456. ABHA numbers are fabricated as
// 91 + 12 digits derived from a hash (a 14-digit value, so never an Aadhaar
// number); the one exception is an ABHA-number login, whose dashed number is
// carried in the transaction id so the same number is verified back.

const MOCK_OTP = '123456'
const PREFIX = 'mock:'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const mockCipher = (plain: string) => `${PREFIX}${sha(plain)}`
const OTP_OK = mockCipher(MOCK_OTP)

function digitsFrom(hex: string, n: number): string {
  let out = ''
  for (let i = 0; out.length < n; i++) out += String(parseInt(hex[i % hex.length], 16) % 10)
  return out
}

const fabricatedAbha = (seed: string) => `91${digitsFrom(sha(seed), 12)}`
const mockAddress = (abhaNumber: string) => `mock${abhaNumber.slice(-8)}`

function profileFor(abhaNumber: string, mobile: string | null): AbhaProfileView {
  const address = `${mockAddress(abhaNumber)}@sbx`
  return {
    abhaNumber,
    abhaAddresses: [address],
    preferredAbhaAddress: address,
    name: 'Sandbox Mock Patient',
    gender: null,
    yearOfBirth: null,
    mobileMasked: mobile && mobile.length >= 4 ? `******${mobile.slice(-4)}` : null,
    abhaStatus: 'ACTIVE',
  }
}

const isCipher = (v: string) => v.startsWith(PREFIX) && v.length === PREFIX.length + 64
const invalid = { ok: false, error: 'invalid_input' } as const
const otpInvalid = { ok: false, error: 'otp_invalid' } as const

// Transaction ids and user tokens carry the (non-secret, fabricated) ABHA number they belong to.
const userTokenFor = (abhaNumber: string) => `mock-user:${abhaNumber}`
function abhaFromUserToken(token: string): string | null {
  const m = /^mock-user:(\d{14})$/.exec(token)
  return m ? m[1] : null
}

export function mockAbdmGateway(): AbdmGateway {
  return {
    source: 'abdm_sandbox_mock',
    status: () => ({ state: 'mock', label: CAPABILITY_LABEL.mock }),

    async testConnection() {
      return { ok: true, value: { tokenExpiresInSeconds: 1800 } }
    },

    async encrypt(plaintext) {
      // ABHA numbers typed for an ABHA-number login are not secret; keep them readable inside the
      // mock "ciphertext" so the same number is verified back. Everything else is only hashed.
      if (/^\d{2}-\d{4}-\d{4}-\d{4}$/.test(plaintext)) return { ok: true, value: `${mockCipher(plaintext)}:abha:${normalizeAbhaNumber(plaintext)}` }
      return { ok: true, value: mockCipher(plaintext) }
    },

    async enrolRequestAadhaarOtp({ encryptedAadhaar }) {
      if (!isCipher(encryptedAadhaar)) return invalid
      return { ok: true, value: { txnId: `mock-enrol-${sha(encryptedAadhaar).slice(0, 24)}` } }
    },

    async enrolByAadhaarOtp({ txnId, encryptedOtp, mobile }) {
      if (!txnId.startsWith('mock-enrol-')) return invalid
      if (encryptedOtp !== OTP_OK) return otpInvalid
      const abhaNumber = fabricatedAbha(txnId)
      return { ok: true, value: { txnId, userToken: userTokenFor(abhaNumber), profile: profileFor(abhaNumber, mobile), isNew: true } }
    },

    async enrolAddressSuggestions({ txnId }) {
      if (!txnId.startsWith('mock-enrol-')) return invalid
      const base = mockAddress(fabricatedAbha(txnId))
      return { ok: true, value: { suggestions: [base, `${base}.sbx`] } }
    },

    async enrolSetAddress({ txnId, abhaAddress }) {
      if (!txnId.startsWith('mock-enrol-')) return invalid
      const full = abhaAddress.includes('@') ? abhaAddress : `${abhaAddress}@sbx`
      if (!isValidAbhaAddress(full)) return invalid
      return { ok: true, value: { preferredAbhaAddress: full.toLowerCase() } }
    },

    async loginRequestOtp({ route, encryptedLoginId }) {
      const parts = encryptedLoginId.split(':abha:')
      const cipher = parts[0]
      const carried = parts.length === 2 ? parts[1] : null
      if (!isCipher(cipher)) return invalid
      const abhaNumber = carried && isValidAbhaNumber(carried) ? carried : fabricatedAbha(`${route}:${cipher}`)
      return { ok: true, value: { txnId: `mock-login-${route}-${abhaNumber}` } }
    },

    async loginVerifyOtp({ route, txnId, encryptedOtp }) {
      const m = /^mock-login-([a-z_]+)-(\d{14})$/.exec(txnId)
      if (!m || m[1] !== route) return invalid
      if (encryptedOtp !== OTP_OK) return otpInvalid
      const abhaNumber = m[2]
      if (route === 'mobile_otp') {
        const second = fabricatedAbha(`second:${abhaNumber}`)
        return {
          ok: true,
          value: { userToken: null, transientToken: `mock-t:${txnId}`, accounts: [{ abhaNumber, name: 'Sandbox Mock Patient' }, { abhaNumber: second, name: 'Sandbox Mock Relative' }] },
        }
      }
      return { ok: true, value: { userToken: userTokenFor(abhaNumber), transientToken: null, accounts: [{ abhaNumber, name: 'Sandbox Mock Patient' }] } }
    },

    async loginSelectAccount({ transientToken, txnId, abhaNumber }) {
      if (transientToken !== `mock-t:${txnId}`) return invalid
      const m = /^mock-login-mobile_otp-(\d{14})$/.exec(txnId)
      if (!m) return invalid
      const allowed = [m[1], fabricatedAbha(`second:${m[1]}`)]
      const chosen = normalizeAbhaNumber(abhaNumber)
      if (!allowed.includes(chosen)) return invalid
      return { ok: true, value: { userToken: userTokenFor(chosen) } }
    },

    async fetchProfile({ userToken }): Promise<AbdmResult<AbhaProfileView>> {
      const abhaNumber = abhaFromUserToken(userToken)
      if (!abhaNumber) return { ok: false, error: 'flow_expired' }
      return { ok: true, value: profileFor(abhaNumber, null) }
    },
  }
}
