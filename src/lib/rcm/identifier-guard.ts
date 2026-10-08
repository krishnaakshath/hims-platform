// SP7: the only SP7 caller of the national-ID detector. Policy and member numbers that look
// like a national ID number (Verhoeff check) are refused at the schema (ruling 9).
import { containsAadhaarLike } from '@/lib/india/aadhaar'

export const NATIONAL_ID_MESSAGE = 'This looks like a national ID number; enter the policy or card number instead'

export function looksLikeNationalId(text: string): boolean {
  return containsAadhaarLike(text)
}
