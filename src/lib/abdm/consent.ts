import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AbdmConfig } from '@/lib/integrations/config'
import type { AbdmConsentPurpose } from './constants'

// The consent shown before an ABHA is created or verified (S1 M1 test case
// CRT_ABHA_102: show the full consent text and collect consent before the
// national ID number is sent). The NHA enrolment text is NOT in the
// repository: the owner installs it verbatim (UNVERIFIED U16), at
// ABDM_CONSENT_TEXT_PATH or the default path below. Until then ABHA creation
// is unavailable; verification uses the hospital's own statement below.
// The consent row stores the SHA-256 of the exact text the patient agreed to.

export const DEFAULT_CONSENT_TEXT_PATH = 'docs/abdm/abha-enrolment-consent-1.4.txt'
export const MOCK_CONSENT_TEXT = 'SANDBOX MOCK CONSENT - not the NHA text'
export const VERIFICATION_CONSENT_TEXT =
  'I agree that the hospital may verify my ABHA (Ayushman Bharat Health Account) with the National Health Authority (ABDM) by a one-time password, ' +
  'and record the verified ABHA number and ABHA address in my hospital record. I understand that I can decline, and that my care does not depend on it.'

export type ConsentText = { text: string; sha256: string }

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const withHash = (text: string): ConsentText => ({ text, sha256: sha256Hex(text) })

/** The installed NHA enrolment consent text, or null when the file is missing or empty. */
export function loadConsentText(cfg: AbdmConfig | null, cwd: string = process.cwd()): ConsentText | null {
  const file = cfg?.consentTextPath ?? DEFAULT_CONSENT_TEXT_PATH
  try {
    const text = readFileSync(path.isAbsolute(file) ? file : path.join(cwd, file), 'utf8')
    return text.trim().length > 0 ? withHash(text) : null
  } catch {
    return null
  }
}

/**
 * The text a consent of this purpose is given against. The labelled mock uses
 * its own fixed enrolment text; a real gateway needs the installed NHA text.
 */
export function consentTextFor(purpose: AbdmConsentPurpose, opts: { mock: boolean; cfg: AbdmConfig | null; cwd?: string }): ConsentText | null {
  if (purpose === 'abha_verification') return withHash(VERIFICATION_CONSENT_TEXT)
  if (opts.mock) return withHash(MOCK_CONSENT_TEXT)
  return loadConsentText(opts.cfg, opts.cwd)
}
