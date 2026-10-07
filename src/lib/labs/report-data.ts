// SP5: the lab report data shape and its pure builder (Task 13). The PDF renderer
// (report-pdf.ts) consumes only this shape. Every field is projected explicitly: no source row is
// spread into the output, there is no Aadhaar or ABHA field of any kind, no date of birth (only
// the age), and no phone number or address. Only verified results become rows.
import type { Brand } from '@/lib/brand'
import { GENDERS } from '@/lib/india/reference'
import { ageOnDate, istDateOf } from '@/lib/india-time'

export type LabResultFlag = 'normal' | 'abnormal' | 'critical'

export interface LabReportData {
  hospital: { name: string; legalName: string; site: string | null }
  reportNumber: string
  version: number
  generatedAt: string // ISO instant
  patient: { name: string; uhid: string | null; patientId: string; ageYears: number; gender: string | null }
  referringDoctor: { name: string; registration: string | null }
  rows: {
    testName: string
    testCode: string
    sampleId: string | null
    value: string
    unit: string | null
    referenceRange: string | null
    flag: LabResultFlag
    collectedAt: string | null
    receivedAt: string | null
    verifiedByName: string
    verifiedAt: string
  }[]
  verifiers: string[] // distinct, in row order
}

/** The raw inputs, each already reduced to named columns by the loader (Task 14). */
export interface LabReportSource {
  hospital: LabReportData['hospital']
  reportNumber: string
  version: number
  patient: { id: string; name: string; dob: string; uhid: string | null; gender: string | null }
  provider: { name: string; registrationCouncil: 'nmc' | 'smc' | null; registrationStateCode: string | null; registrationNumber: string | null }
  orders: {
    testName: string
    testCode: string
    sampleId: string | null
    /** The catalogue range of the test, used when the result carries none. */
    testReferenceRange: string | null
    collectedAt: Date | null
    receivedAt: Date | null
    /** Null for a result that is not verified: such an order never becomes a report row. */
    verifiedAt: Date | null
    verifiedByName: string | null
    result: { value: string; unit: string | null; referenceRange: string | null; flag: LabResultFlag }
  }[]
}

const GENDER_LABEL = new Map<string, string>(GENDERS.map((g) => [g.code, g.label]))

/** The report header names from the brand module (passed in, so this module stays pure). */
export function hospitalFromBrand(b: Pick<Brand, 'name' | 'legalName'>, site: string | null = null): LabReportData['hospital'] {
  return { name: b.name, legalName: b.legalName, site }
}

/** The same rule as SP3's discharge summary. */
function registration(p: LabReportSource['provider']): string | null {
  if (!p.registrationNumber) return null
  if (p.registrationCouncil === 'nmc') return `NMC ${p.registrationNumber}`
  if (p.registrationCouncil === 'smc' && p.registrationStateCode) return `SMC ${p.registrationStateCode} ${p.registrationNumber}`
  return null
}

export function buildLabReportData(src: LabReportSource, now: Date): LabReportData {
  const rows: LabReportData['rows'] = []
  for (const o of src.orders) {
    if (o.verifiedAt === null || o.verifiedByName === null) continue
    rows.push({
      testName: o.testName,
      testCode: o.testCode,
      sampleId: o.sampleId,
      value: o.result.value,
      unit: o.result.unit,
      referenceRange: o.result.referenceRange ?? o.testReferenceRange,
      flag: o.result.flag,
      collectedAt: o.collectedAt ? o.collectedAt.toISOString() : null,
      receivedAt: o.receivedAt ? o.receivedAt.toISOString() : null,
      verifiedByName: o.verifiedByName,
      verifiedAt: o.verifiedAt.toISOString(),
    })
  }
  const verifiers: string[] = []
  for (const r of rows) if (!verifiers.includes(r.verifiedByName)) verifiers.push(r.verifiedByName)

  const p = src.patient
  return {
    hospital: { name: src.hospital.name, legalName: src.hospital.legalName, site: src.hospital.site },
    reportNumber: src.reportNumber,
    version: src.version,
    generatedAt: now.toISOString(),
    patient: {
      name: p.name,
      uhid: p.uhid,
      patientId: p.id,
      ageYears: ageOnDate(p.dob, istDateOf(now)),
      gender: p.gender ? (GENDER_LABEL.get(p.gender) ?? p.gender) : null,
    },
    referringDoctor: { name: src.provider.name, registration: registration(src.provider) },
    rows,
    verifiers,
  }
}

export function flagLabel(flag: LabResultFlag): '' | 'ABNORMAL' | 'CRITICAL' {
  if (flag === 'abnormal') return 'ABNORMAL'
  if (flag === 'critical') return 'CRITICAL'
  return ''
}

// Typographic punctuation that WinAnsi could encode (0x80-0x9F) but the rule below keeps out:
// mapped to plain ASCII first so a pasted name or range stays readable.
const ASCII_PUNCTUATION: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-', '…': '...', '•': '*',
}

/**
 * Text the PDF's standard fonts (Helvetica, WinAnsi encoding) can draw. Whitespace runs (incl.
 * no-break and narrow no-break spaces from Intl output) collapse to one space and are trimmed;
 * typographic quotes/dashes become ASCII; every other character outside printable WinAnsi
 * (`\x20-\x7E`, `\xA0-\xFF`) becomes '?', one per code point.
 *
 * KNOWN LIMITATION: Indian-script text (Devanagari, Tamil, ...) prints as '?'. Embedding a
 * Unicode font is a later improvement (plan Ruling 2: dependency-light, no font files read at
 * runtime). The chart and the portal show names correctly.
 */
export function toPdfSafeText(s: string): string {
  let out = ''
  for (const ch of Array.from(s.replace(/\s+/g, ' ').trim())) {
    const mapped = ASCII_PUNCTUATION[ch]
    if (mapped !== undefined) { out += mapped; continue }
    const code = ch.codePointAt(0)!
    out += (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? ch : '?'
  }
  return out
}
