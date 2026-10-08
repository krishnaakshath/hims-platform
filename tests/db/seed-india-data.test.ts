import { describe, it, expect } from 'vitest'
import {
  syntheticAadhaar, syntheticAbhaNumber, syntheticMobile, gstinWithCheck, DEMO_HOSPITAL, DEPARTMENT_SEED, DOCTOR_ROSTER,
  PAYERS_SEED, ROOM_CATEGORY_SEED, ROOM_SEED, SERVICE_SEED, PACKAGE_ITEMS_SEED, DEPARTMENT_TARIFFS, PAYER_TARIFFS,
  INDIA_LAB_TESTS, EXISTING_LAB_TEST_SERVICE_MAP, PLACES, SERVICE_AREA_PINS, HERO_IDENTITIES, FILLER_PROFILES, addressFor,
  demoEmail, DEMO_USERS, SYNTHETIC_AADHAAR_PREFIX, PAYER_PROFILE_SEED, PAYER_NETWORK_SEED,
} from '@/db/seed-india-data'
import { payerProfileSchema } from '@/lib/rcm/validation'
import { INSURER_SIDE_KINDS } from '@/lib/rcm/constants'
import { isValidAadhaar } from '@/lib/india/aadhaar'
import { isValidAbhaNumber, isValidAbhaAddress } from '@/lib/india/abha'
import { normalizePhone } from '@/lib/india/phone'
import { isIndianStateCode, isValidPinCode, LANGUAGES } from '@/lib/india/reference'
import { isValidGstin, stateCodeOfGstin } from '@/lib/billing/gst'
import { REGISTRATION_NUMBER_PATTERN } from '@/lib/validation/provider-profile'

const CODE = /^[A-Z][A-Z0-9_]{1,15}$/
const GST_RATES = [0, 500, 1200, 1800, 2800, 4000]

describe('synthetic identifiers', () => {
  it('Aadhaar test values are Verhoeff-valid, share the synthetic prefix and are distinct', () => {
    const values = Array.from({ length: 50 }, (_, i) => syntheticAadhaar(i + 1))
    for (const v of values) {
      expect(isValidAadhaar(v)).toBe(true)
      expect(v.startsWith(SYNTHETIC_AADHAAR_PREFIX)).toBe(true)
    }
    expect(new Set(values).size).toBe(values.length)
    expect(() => syntheticAadhaar(0)).toThrow()
  })

  it('ABHA numbers are 14 digits, distinct and marked synthetic', () => {
    const values = Array.from({ length: 50 }, (_, i) => syntheticAbhaNumber(i + 1))
    for (const v of values) expect(isValidAbhaNumber(v)).toBe(true)
    expect(new Set(values).size).toBe(values.length)
    expect(values.every((v) => v.startsWith('9999990000'))).toBe(true)
  })

  it('mobile numbers are valid Indian mobiles in the stored +91 form', () => {
    for (const n of [0, 142, 99999]) {
      const m = syntheticMobile(n)
      expect(normalizePhone(m)).toBe(m)
    }
  })

  it('GSTINs carry a valid check character and the right state', () => {
    expect(isValidGstin(DEMO_HOSPITAL.gstin)).toBe(true)
    expect(stateCodeOfGstin(DEMO_HOSPITAL.gstin)).toBe(DEMO_HOSPITAL.stateCode)
    expect(isValidGstin(gstinWithCheck('33ZZZSH9999Z1Z'))).toBe(true)
  })
})

describe('hospital masters', () => {
  it('departments have valid unique codes and include the clinical specialities the doctors belong to', () => {
    expect(DEPARTMENT_SEED.every((d) => CODE.test(d.code))).toBe(true)
    expect(new Set(DEPARTMENT_SEED.map((d) => d.code)).size).toBe(DEPARTMENT_SEED.length)
    const codes = new Set(DEPARTMENT_SEED.map((d) => d.code))
    for (const d of DOCTOR_ROSTER) expect(codes.has(d.departmentCode), d.name).toBe(true)
  })

  it('doctors have NMC/SMC registrations in the accepted format and fees in paise', () => {
    expect(DOCTOR_ROSTER.some((d) => d.name === 'Dr. Rajiv Kunam' && d.specialty === 'Psychiatry' && d.credentials === 'MD')).toBe(true)
    for (const d of DOCTOR_ROSTER) {
      expect(REGISTRATION_NUMBER_PATTERN.test(d.registrationNumber), d.name).toBe(true)
      expect(d.registrationNumber.startsWith('DEMO/')).toBe(true)
      if (d.registrationCouncil === 'smc') expect(isIndianStateCode(d.registrationStateCode ?? '')).toBe(true)
      else expect(d.registrationStateCode).toBeNull()
      expect(Number.isInteger(d.consultationFeePaise) && d.consultationFeePaise >= 0).toBe(true)
    }
  })

  it('payers are Indian insurers, TPAs and schemes (no US plans)', () => {
    const names = PAYERS_SEED.map((p) => p.name)
    for (const n of ['Star Health and Allied Insurance', 'ICICI Lombard General Insurance', 'Medi Assist TPA', 'Ayushman Bharat PM-JAY']) {
      expect(names).toContain(n)
    }
    expect(names.some((n) => n.startsWith('CGHS'))).toBe(true)
    expect(names.some((n) => n.startsWith('ECHS'))).toBe(true)
    for (const p of PAYERS_SEED) {
      if (p.stateCode) expect(isIndianStateCode(p.stateCode)).toBe(true)
      if (p.gstin) expect(stateCodeOfGstin(p.gstin)).toBe(p.stateCode)
    }
  })

  it('every seeded payer has an RCM profile the payer form would accept', () => {
    expect(Object.keys(PAYER_PROFILE_SEED).sort()).toEqual(PAYERS_SEED.map((p) => p.name).sort())
    for (const p of PAYERS_SEED) {
      const parsed = payerProfileSchema.safeParse({ ...PAYER_PROFILE_SEED[p.name], gstin: p.gstin, stateCode: p.stateCode })
      expect(parsed.success, p.name).toBe(true)
    }
    expect(PAYER_PROFILE_SEED['Medi Assist TPA'].kind).toBe('tpa')
    expect(PAYER_PROFILE_SEED['Ayushman Bharat PM-JAY'].kind).toBe('government_scheme')
    expect(PAYER_PROFILE_SEED['Star Health and Allied Insurance'].kind).toBe('insurer')
  })

  it('TPA networks link insurer-side payers to TPAs', () => {
    expect(PAYER_NETWORK_SEED.length).toBeGreaterThan(0)
    for (const n of PAYER_NETWORK_SEED) {
      expect(INSURER_SIDE_KINDS).toContain(PAYER_PROFILE_SEED[n.insurer].kind)
      for (const t of n.tpas) expect(PAYER_PROFILE_SEED[t].kind, t).toBe('tpa')
    }
  })

  it('every room has a tariff room category and the wards cover all categories', () => {
    const cats = new Set<string>(ROOM_CATEGORY_SEED.map((c) => c.code))
    expect(ROOM_SEED.every((r) => cats.has(r.category))).toBe(true)
    expect(new Set(ROOM_SEED.map((r) => r.category)).size).toBe(cats.size)
    const keys = ROOM_SEED.map((r) => `${r.ward}|${r.roomNumber}|${r.bedNumber}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('services have valid codes, GST rates and a price (base or per room category)', () => {
    const deptCodes = new Set(DEPARTMENT_SEED.map((d) => d.code))
    for (const s of SERVICE_SEED) {
      expect(CODE.test(s.code), s.code).toBe(true)
      expect(deptCodes.has(s.departmentCode), s.code).toBe(true)
      expect(GST_RATES).toContain(s.gstRateBp)
      expect(s.basePaise !== undefined || s.byRoomCategory !== undefined, s.code).toBe(true)
    }
    expect(new Set(SERVICE_SEED.map((s) => s.code)).size).toBe(SERVICE_SEED.length)
    expect(SERVICE_SEED.find((s) => s.code === 'ROOM_RENT')?.byRoomCategory).toBeDefined()
    expect(SERVICE_SEED.some((s) => s.gstRateBp > 0)).toBe(true)
  })

  it('package items, department and payer tariffs point at known services, departments, payers and categories', () => {
    const svc = new Set(SERVICE_SEED.map((s) => s.code))
    const payers = new Set(PAYERS_SEED.map((p) => p.name))
    const depts = new Set(DEPARTMENT_SEED.map((d) => d.code))
    for (const i of PACKAGE_ITEMS_SEED) expect(svc.has(i.packageCode) && svc.has(i.itemCode)).toBe(true)
    for (const t of DEPARTMENT_TARIFFS) expect(svc.has(t.serviceCode) && depts.has(t.departmentCode)).toBe(true)
    for (const t of PAYER_TARIFFS) expect(svc.has(t.serviceCode) && payers.has(t.payerName)).toBe(true)
  })

  it('lab tests map to lab/imaging services', () => {
    const svc = new Map(SERVICE_SEED.map((s) => [s.code, s]))
    for (const t of INDIA_LAB_TESTS) expect(svc.get(t.serviceCode ?? '')?.category).toBe('investigation_lab')
    for (const m of Object.values(EXISTING_LAB_TEST_SERVICE_MAP)) expect(svc.get(m.serviceCode)?.category).toMatch(/^investigation_/)
  })
})

describe('patients', () => {
  it('places are real Indian state codes with valid PINs; the service area is a subset', () => {
    for (const p of PLACES) {
      expect(isIndianStateCode(p.stateCode)).toBe(true)
      expect(isValidPinCode(p.pinCode)).toBe(true)
    }
    expect(SERVICE_AREA_PINS.length).toBeGreaterThan(0)
    for (const pin of SERVICE_AREA_PINS) expect(PLACES.some((p) => p.pinCode === pin.pinCode && p.local)).toBe(true)
    expect(addressFor(-1, 0).pinCode).toBe(PLACES[PLACES.length - 1].pinCode)
  })

  it('hero ids are unchanged and every patient profile uses a known language', () => {
    expect(HERO_IDENTITIES.map((h) => h.id)).toEqual(['RD-0001', 'RD-0002', 'RD-0003', 'RD-0004', 'RD-0005', 'RD-0006'])
    const langs = new Set<string>(LANGUAGES.map((l) => l.code))
    for (const p of [...HERO_IDENTITIES, ...FILLER_PROFILES]) expect(langs.has(p.preferredLanguage), p.name).toBe(true)
    expect(FILLER_PROFILES.length).toBe(44)
    expect(new Set([...HERO_IDENTITIES, ...FILLER_PROFILES].map((p) => p.name)).size).toBe(50)
  })

  it('demo emails use the reserved example.com domain', () => {
    expect(demoEmail("Joseph D'Souza")).toBe('joseph.dsouza.demo@example.com')
    for (const h of HERO_IDENTITIES) expect(h.email.endsWith('@example.com')).toBe(true)
  })

  it('demo ABHA addresses would validate on the sandbox domain', () => {
    expect(isValidAbhaAddress('meera.krishnan01@sbx')).toBe(true)
  })

  it('demo users cover every staff role with unique logins', () => {
    const roles = new Set(DEMO_USERS.map((u) => u.role))
    for (const r of ['admin', 'crc', 'pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'collector', 'coder']) expect(roles.has(r as never)).toBe(true)
    expect(new Set(DEMO_USERS.map((u) => u.local)).size).toBe(DEMO_USERS.length)
  })
})
