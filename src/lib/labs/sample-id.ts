// Pure, client-safe sample ID format: 'L' + IST yymmdd + daily sequence (≥4
// digits) + Verhoeff check digit over the digits. Stored canonical
// (`L26100800429`), displayed grouped (`L261008-0042-9`).
import { verhoeffCheckDigit, verhoeffValidate } from '@/lib/india/verhoeff'

const MAX_SEQ = 999_999

function yymmddOf(dateIso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso)
  if (!m || !m[1].startsWith('20')) throw new Error('formatSampleId: dateIso must be YYYY-MM-DD in 20yy')
  return `${m[1].slice(2)}${m[2]}${m[3]}`
}

export function formatSampleId(dateIso: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1 || seq > MAX_SEQ) throw new Error('formatSampleId: seq must be an integer 1–999999')
  const digits = yymmddOf(dateIso) + String(seq).padStart(4, '0')
  return `L${digits}${verhoeffCheckDigit(digits)}`
}

function realDate(yy: string, mm: string, dd: string): string | null {
  const y = 2000 + Number(yy)
  const m = Number(mm)
  const d = Number(dd)
  const t = new Date(Date.UTC(y, m - 1, d))
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null
  return `${y}-${mm}-${dd}`
}

export function parseSampleId(input: string): { canonical: string; dateIso: string; seq: number } | null {
  const canonical = input.replace(/[\s-]/g, '').toUpperCase()
  const m = /^L(\d{6})(\d{4,6})(\d)$/.exec(canonical)
  if (!m) return null
  if (!verhoeffValidate(m[1] + m[2] + m[3])) return null
  const dateIso = realDate(m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6))
  if (!dateIso) return null
  const seq = Number(m[2])
  if (seq < 1) return null
  return { canonical, dateIso, seq }
}

export function displaySampleId(canonical: string): string {
  const m = /^L(\d{6})(\d{4,6})(\d)$/.exec(canonical)
  if (!m) return canonical
  return `L${m[1]}-${m[2]}-${m[3]}`
}
