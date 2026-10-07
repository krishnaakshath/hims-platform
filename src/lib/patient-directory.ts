// Patient directory (/patients) filter and paging, pure and client-safe
// (Wave B P1-08). Shared with the global search's phone matching.

export const PATIENT_PAGE_SIZE = 30
const MAX_QUERY = 100
const MIN_PHONE_DIGITS = 5
const PHONE_SHAPED = /^[+\d\s\-().]+$/

/** The national digits of a phone-shaped query with at least 5 digits, else
 *  null -- so 'RD-0001' or '0002' never phone-matches every number. A +91 /
 *  91 / 0 prefix is dropped so '+91 98765 43210' and '9876543210' agree. */
export function phoneQueryDigits(raw: string): string | null {
  const q = raw.trim()
  if (!PHONE_SHAPED.test(q)) return null
  let d = q.replace(/\D/g, '')
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return d.length >= MIN_PHONE_DIGITS ? d : null
}

export interface DirectoryMatchable { id: string; name: string; uhid?: string | null; phone?: string | null }

/** Name, anon id, UHID (substring, case-insensitive) or mobile (digits). */
export function matchesDirectoryQuery(p: DirectoryMatchable, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase()
  if (!q) return true
  if (p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) return true
  if (p.uhid && p.uhid.toLowerCase().includes(q)) return true
  const digits = phoneQueryDigits(q)
  return digits !== null && !!p.phone && p.phone.replace(/\D/g, '').includes(digits)
}

export interface Page<T> { rows: T[]; page: number; pageSize: number; total: number; pageCount: number }

export function paginate<T>(rows: T[], page: number, pageSize: number = PATIENT_PAGE_SIZE): Page<T> {
  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount)
  return { rows: rows.slice((p - 1) * pageSize, p * pageSize), page: p, pageSize, total, pageCount }
}

type Param = string | string[] | undefined
const first = (v: Param) => (Array.isArray(v) ? v[0] : v)

export function parseDirectoryParams(sp: Record<string, Param>): { q: string; page: number } {
  const q = (first(sp.q) ?? '').trim().slice(0, MAX_QUERY)
  const n = Number(first(sp.page))
  return { q, page: Number.isInteger(n) && n > 0 ? n : 1 }
}

/** '+919876543210' -> '+91 98765 43210'; anything else unchanged. */
export function formatPhoneForDisplay(phone: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(phone)
  return m ? `+91 ${m[1]} ${m[2]}` : phone
}
