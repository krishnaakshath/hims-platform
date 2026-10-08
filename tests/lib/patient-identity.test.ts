import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { decryptSensitive } from '@/lib/crypto'
import {
  buildAadhaarRow, toAadhaarSummary, toAadhaarView, identityAuditEntries,
  type IdentitySnapshot, type AadhaarSummary,
} from '@/lib/patient-identity'
import type { AadhaarInput } from '@/lib/validation/patient-registration'
import type { Role } from '@/lib/auth'

const AADHAAR = '234567890124' // Verhoeff-valid test number
const NOW = new Date('2026-10-07T05:00:00Z')

beforeEach(() => {
  vi.stubEnv('IDENTITY_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'))
})
afterEach(() => {
  vi.unstubAllEnvs()
})

// Any 4-digit window of the plaintext number, anywhere in the text. Strict:
// callers remove the explicitly-stored last4 field before serialising.
function containsAadhaarFragment(text: string): boolean {
  for (let i = 0; i + 4 <= AADHAAR.length; i++) {
    if (text.includes(AADHAAR.slice(i, i + 4))) return true
  }
  return false
}

describe('buildAadhaarRow', () => {
  it('buildAadhaarRow encrypts, keeps last4, records consent', () => {
    const row = buildAadhaarRow('TEST-SP1-1', { status: 'provided', number: AADHAAR, consent: true }, 'Asha', NOW)
    expect(row.aadhaarEncrypted).not.toContain(AADHAAR)
    expect(decryptSensitive(row.aadhaarEncrypted!)).toBe(AADHAAR)
    expect(row.aadhaarLast4).toBe('0124')
    expect(row.consentGiven).toBe(true)
    expect(row.consentRecordedAt).toEqual(NOW)
    expect(row.declineReason).toBeNull()
    expect(row.declineNote).toBeNull()
    expect(row.patientId).toBe('TEST-SP1-1')
    expect(row.recordedByName).toBe('Asha')
    expect(row.updatedAt).toEqual(NOW)
  })

  it('the provided row carries no plaintext fragment outside last4', () => {
    const row = buildAadhaarRow('TEST-SP1-1', { status: 'provided', number: AADHAAR, consent: true }, 'Asha', NOW)
    const { aadhaarLast4: _last4, ...rest } = row
    void _last4
    expect(containsAadhaarFragment(JSON.stringify(rest))).toBe(false)
  })

  it('normalises a spaced/hyphenated number defensively before encrypting', () => {
    const input = { status: 'provided', number: '2345 6789-0124', consent: true } as AadhaarInput
    const row = buildAadhaarRow('TEST-SP1-1', input, 'Asha', NOW)
    expect(decryptSensitive(row.aadhaarEncrypted!)).toBe(AADHAAR)
    expect(row.aadhaarLast4).toBe('0124')
  })

  it('throws on an invalid number without echoing any digit of it', () => {
    const bad = '234567890125' // checksum wrong
    const input = { status: 'provided', number: bad, consent: true } as AadhaarInput
    let err: unknown
    try { buildAadhaarRow('TEST-SP1-1', input, 'Asha', NOW) } catch (e) { err = e }
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).not.toMatch(/\d{4}/)
    expect(String((err as Error).stack)).not.toContain(bad)
  })

  it('throws when consent is not literally true (runtime guard beyond the type)', () => {
    const input = { status: 'provided', number: AADHAAR, consent: false } as unknown as AadhaarInput
    expect(() => buildAadhaarRow('TEST-SP1-1', input, 'Asha', NOW)).toThrow(/consent/i)
  })

  it('a missing encryption key error does not echo the number', () => {
    vi.stubEnv('IDENTITY_ENCRYPTION_KEY', '')
    let err: unknown
    try { buildAadhaarRow('TEST-SP1-1', { status: 'provided', number: AADHAAR, consent: true }, 'Asha', NOW) } catch (e) { err = e }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toMatch(/\d{4}/)
  })

  it('buildAadhaarRow for a decline nulls ciphertext and last4', () => {
    const row = buildAadhaarRow('TEST-SP1-1', { status: 'declined', reason: 'patient_declined' }, 'Asha', new Date())
    expect(row).toMatchObject({ aadhaarEncrypted: null, aadhaarLast4: null, consentGiven: false, consentRecordedAt: null, declineReason: 'patient_declined', declineNote: null })
  })

  it('a decline keeps its note', () => {
    const row = buildAadhaarRow('TEST-SP1-1', { status: 'declined', reason: 'other', note: 'Lost card' }, 'Asha', NOW)
    expect(row).toMatchObject({ declineReason: 'other', declineNote: 'Lost card', updatedAt: NOW })
  })

  it('throws a fixed message for an unknown decline reason (runtime guard beyond the type)', () => {
    const input = { status: 'declined', reason: AADHAAR } as unknown as AadhaarInput
    let err: unknown
    try { buildAadhaarRow('TEST-SP1-1', input, 'Asha', NOW) } catch (e) { err = e }
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('Invalid Aadhaar decline reason')
    // The stack has file line numbers, so check for the value itself.
    expect(String((err as Error).stack)).not.toContain(AADHAAR)
  })

  it('throws a fixed message for reason other without a non-empty note', () => {
    for (const note of [undefined, '', '   ']) {
      const input = { status: 'declined', reason: 'other', note } as unknown as AadhaarInput
      expect(() => buildAadhaarRow('TEST-SP1-1', input, 'Asha', NOW)).toThrow(/^A note is required when the reason is other$/)
    }
  })

  it('redacts an Aadhaar number from a decline note that bypassed the schema', () => {
    for (const n of [AADHAAR, '2345 6789 0124', '2345.6789.0124', '2345/6789/0124']) {
      const input = { status: 'declined', reason: 'other', note: `card ${n} lost` } as AadhaarInput
      const row = buildAadhaarRow('TEST-SP1-1', input, 'Asha', NOW)
      expect(row.declineNote).toBe('card [redacted] lost')
      expect(containsAadhaarFragment(JSON.stringify(row))).toBe(false)
    }
  })
})

describe('toAadhaarSummary / toAadhaarView', () => {
  const onFile = () => toAadhaarSummary({ aadhaarLast4: '0124', declineReason: null, consentRecordedAt: new Date(), recordedByName: 'Asha' })

  it('derives the three statuses', () => {
    expect(onFile().status).toBe('on_file')
    expect(toAadhaarSummary({ aadhaarLast4: null, declineReason: 'emergency', consentRecordedAt: null, recordedByName: 'Asha' }))
      .toEqual({ status: 'declined', last4: null, declineReason: 'emergency', consentRecordedAt: null, recordedByName: 'Asha' })
    expect(toAadhaarSummary(null)).toEqual({ status: 'not_recorded', last4: null, declineReason: null, consentRecordedAt: null, recordedByName: null })
  })

  it('never copies aadhaarEncrypted even if a whole row is passed at runtime', () => {
    const wholeRow = { aadhaarEncrypted: 'iv:tag:ct', aadhaarLast4: '0124', declineReason: null, consentRecordedAt: NOW, recordedByName: 'Asha' }
    const s = toAadhaarSummary(wholeRow)
    expect(Object.keys(s).sort()).toEqual(['consentRecordedAt', 'declineReason', 'last4', 'recordedByName', 'status'])
    expect(JSON.stringify(s)).not.toContain('iv:tag:ct')
  })

  it('drops a malformed last4 (e.g. a full number) instead of masking it', () => {
    const s = toAadhaarSummary({ aadhaarLast4: AADHAAR, declineReason: null, consentRecordedAt: NOW, recordedByName: 'Asha' })
    expect(s.last4).toBeNull()
    expect(JSON.stringify(toAadhaarView(s, 'admin'))).not.toMatch(/\d{5}/)
  })

  it('toAadhaarView shows last4 only to admin and crc', () => {
    const s = onFile()
    expect(toAadhaarView(s, 'admin').masked).toBe('XXXX XXXX 0124')
    expect(toAadhaarView(s, 'crc').masked).toBe('XXXX XXXX 0124')
    for (const r of ['pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm'] as const) {
      expect(toAadhaarView(s, r)).toEqual({ status: 'on_file', masked: null, declineReason: null })
      expect(JSON.stringify(toAadhaarView(s, r))).not.toContain('0124')
    }
  })

  it('denies masked read to an unknown role (allowlist)', () => {
    expect(toAadhaarView(onFile(), 'patient' as Role).masked).toBeNull()
  })

  it('shows the decline reason only to admin and crc; everyone else sees status only', () => {
    const declined = toAadhaarSummary({ aadhaarLast4: null, declineReason: 'foreign_national', consentRecordedAt: null, recordedByName: 'Asha' })
    for (const r of ['pi', 'frontdesk', 'pharmacy', 'billing', 'labs', 'coder', 'collector', 'rcm', 'patient'] as Role[]) {
      expect(toAadhaarView(declined, r)).toEqual({ status: 'declined', masked: null, declineReason: null })
    }
    expect(toAadhaarView(declined, 'admin').declineReason).toBe('foreign_national')
  })

  it('the view never carries recordedByName, consent time or raw last4 fields', () => {
    expect(Object.keys(toAadhaarView(onFile(), 'admin')).sort()).toEqual(['declineReason', 'masked', 'status'])
  })

  it('never masks a declined or not-recorded summary', () => {
    const declined: AadhaarSummary = { status: 'declined', last4: '0124', declineReason: 'emergency', consentRecordedAt: null, recordedByName: 'Asha' }
    expect(toAadhaarView(declined, 'admin')).toEqual({ status: 'declined', masked: null, declineReason: 'emergency' })
    expect(toAadhaarView(declined, 'crc')).toEqual({ status: 'declined', masked: null, declineReason: 'emergency' })
    expect(toAadhaarView(toAadhaarSummary(null), 'crc')).toEqual({ status: 'not_recorded', masked: null, declineReason: null })
  })
})

describe('identityAuditEntries', () => {
  const base: IdentitySnapshot = { aadhaarStatus: 'not_recorded', aadhaarDeclineReason: null, abhaNumber: null, abhaAddress: null, abhaUnavailableReason: null, isMlc: false }
  const declined: IdentitySnapshot = { ...base, aadhaarStatus: 'declined', aadhaarDeclineReason: 'patient_declined' }
  const onFile: IdentitySnapshot = { ...base, aadhaarStatus: 'on_file' }

  it('identityAuditEntries reports declined→on_file as recorded-with-consent', () => {
    expect(identityAuditEntries(declined, onFile, true)).toEqual([{ action: 'recorded Aadhaar with consent', details: null }])
  })

  it('identityAuditEntries reports on_file→on_file write as replaced', () => {
    expect(identityAuditEntries(onFile, onFile, true)).toEqual([{ action: 'replaced Aadhaar', details: null }])
  })

  it('reports on_file→declined as a decline with the reason code', () => {
    const after = { ...base, aadhaarStatus: 'declined' as const, aadhaarDeclineReason: 'emergency' }
    expect(identityAuditEntries(onFile, after, true)).toEqual([{ action: 'recorded Aadhaar decline', details: 'reason: emergency' }])
  })

  it('reports no Aadhaar entry when Aadhaar was not written (profile edit)', () => {
    expect(identityAuditEntries(onFile, onFile, false)).toEqual([])
    expect(identityAuditEntries(declined, declined, false)).toEqual([])
  })

  it('identityAuditEntries for a registration lists every set item and never contains digits', () => {
    const entries = identityAuditEntries(null, { aadhaarStatus: 'declined', aadhaarDeclineReason: 'emergency', abhaNumber: '12345678901234', abhaAddress: 'ravi.kumar@abdm', abhaUnavailableReason: null, isMlc: true }, true)
    expect(entries.map((e) => e.action)).toEqual(['recorded Aadhaar decline', 'set ABHA number', 'set ABHA address', 'set MLC flag'])
    expect(JSON.stringify(entries)).not.toMatch(/\d{4}|ravi/)
  })

  it('a registration with Aadhaar on file and ABHA unavailable', () => {
    const entries = identityAuditEntries(null, { ...onFile, abhaUnavailableReason: 'not_created' }, true)
    expect(entries).toEqual([
      { action: 'recorded Aadhaar with consent', details: null },
      { action: 'recorded ABHA unavailable', details: 'reason: not_created' },
    ])
  })

  it('reports ABHA changes and removals and MLC clear without values', () => {
    const before = { ...base, abhaNumber: '12345678901234', abhaAddress: 'ravi.kumar@abdm', isMlc: true }
    const after = { ...base, abhaNumber: '98765432109876', abhaAddress: null, isMlc: false }
    const entries = identityAuditEntries(before, after, false)
    expect(entries).toEqual([
      { action: 'changed ABHA number', details: null },
      { action: 'removed ABHA address', details: null },
      { action: 'cleared MLC flag', details: null },
    ])
    expect(JSON.stringify(entries)).not.toMatch(/\d{4}|ravi/)
    expect(identityAuditEntries(after, { ...after, abhaNumber: null, abhaAddress: 'x@abdm' }, false).map((e) => e.action))
      .toEqual(['removed ABHA number', 'set ABHA address'])
  })

  it('unchanged identity yields no entries', () => {
    const s = { ...onFile, abhaNumber: '12345678901234', abhaUnavailableReason: null, isMlc: true }
    expect(identityAuditEntries(s, { ...s }, false)).toEqual([])
  })

  it('reports a new or changed ABHA-unavailable reason only', () => {
    const before = { ...base, abhaUnavailableReason: 'not_created' }
    expect(identityAuditEntries(before, { ...before }, false)).toEqual([])
    expect(identityAuditEntries(before, { ...base, abhaUnavailableReason: 'emergency' }, false))
      .toEqual([{ action: 'recorded ABHA unavailable', details: 'reason: emergency' }])
  })

  it('never writes an unknown reason string into details (only known codes)', () => {
    const after = { ...base, aadhaarStatus: 'declined' as const, aadhaarDeclineReason: AADHAAR, abhaUnavailableReason: 'see 2345 6789 0124' }
    const entries = identityAuditEntries(null, after, true)
    expect(entries).toEqual([
      { action: 'recorded Aadhaar decline', details: 'reason: unknown' },
      { action: 'recorded ABHA unavailable', details: 'reason: unknown' },
    ])
  })
})
