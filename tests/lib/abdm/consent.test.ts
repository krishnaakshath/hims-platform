import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { consentTextFor, loadConsentText, MOCK_CONSENT_TEXT, sha256Hex, VERIFICATION_CONSENT_TEXT } from '@/lib/abdm/consent'
import type { AbdmConfig } from '@/lib/integrations/config'

const CFG = (consentTextPath: string | null): AbdmConfig => ({
  gatewayBaseUrl: 'https://g', abhaBaseUrl: 'https://a', clientId: 'c', clientSecret: 's', cmId: 'sbx', hipId: null, gatewayJwksUrl: null, consentTextPath,
})

describe('ABDM consent text', () => {
  it('loads the installed text verbatim with its hash, or null when missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sp8-consent-'))
    const file = path.join(dir, 'c.txt')
    writeFileSync(file, 'I agree.\nLine two.\n')
    expect(loadConsentText(CFG(file))).toEqual({ text: 'I agree.\nLine two.\n', sha256: sha256Hex('I agree.\nLine two.\n') })
    expect(loadConsentText(CFG(path.join(dir, 'missing.txt')))).toBeNull()
    expect(loadConsentText(null, dir)).toBeNull()
  })
  it('the mock and verification texts are fixed', () => {
    expect(consentTextFor('abha_enrolment', { mock: true, cfg: null })!.text).toBe(MOCK_CONSENT_TEXT)
    expect(consentTextFor('abha_verification', { mock: false, cfg: null })!.text).toBe(VERIFICATION_CONSENT_TEXT)
    expect(consentTextFor('abha_enrolment', { mock: false, cfg: CFG('/nonexistent/x.txt') })).toBeNull()
  })
})
