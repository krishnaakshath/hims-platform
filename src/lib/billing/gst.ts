// Pure GST logic: state codes, GSTIN check, place of supply, per-line tax split (BigInt, half-up per line).
import { INDIAN_STATES, isIndianStateCode } from '@/lib/india/reference'
import { GST_RATES_BP } from '@/lib/tariff/validation'

const GST_CODE_BY_STATE: Record<string, string> = {
  AN: '35', AP: '37', AR: '12', AS: '18', BR: '10', CH: '04', CG: '22', DH: '26', DL: '07', GA: '30', GJ: '24', HR: '06',
  HP: '02', JK: '01', JH: '20', KA: '29', KL: '32', LA: '38', LD: '31', MP: '23', MH: '27', MN: '14', ML: '17', MZ: '15',
  NL: '13', OD: '21', PY: '34', PB: '03', RJ: '08', SK: '11', TN: '33', TS: '36', TR: '16', UP: '09', UK: '05', WB: '19',
}

/** SP1 `IN-xx` state code → two-digit GST state code. */
export const GST_STATE_CODES: Record<string, string> = Object.fromEntries(
  Object.entries(GST_CODE_BY_STATE).map(([k, v]) => [`IN-${k}`, v]),
)

// Guard against drift from the SP1 list at load time (the tests assert the same).
for (const s of INDIAN_STATES) if (!(s.code in GST_STATE_CODES)) throw new Error(`No GST code for ${s.code}`)

const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const CHECK_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function stateCodeOfGstin(gstin: string): string | null {
  const prefix = gstin.slice(0, 2)
  for (const [code, gst] of Object.entries(GST_STATE_CODES)) if (gst === prefix) return code
  return null
}

export function isValidGstin(gstin: string): boolean {
  if (!GSTIN_FORMAT.test(gstin)) return false
  if (stateCodeOfGstin(gstin) === null) return false
  const g = gstin
  let s = 0
  for (let i = 0; i < 14; i++) {
    const p = CHECK_CHARS.indexOf(g[i]) * (i % 2 ? 2 : 1)
    s += Math.floor(p / 36) + (p % 36)
  }
  return CHECK_CHARS[(36 - (s % 36)) % 36] === g[14]
}

export type PlaceOfSupplyMode = 'location_of_service' | 'recipient_state'
export type SupplyType = 'intra' | 'inter'

export function placeOfSupply(input: {
  mode: PlaceOfSupplyMode
  hospitalStateCode: string
  recipientStateCode: string | null
}): { stateCode: string; supplyType: SupplyType } {
  const { mode, hospitalStateCode, recipientStateCode } = input
  if (mode === 'recipient_state' && recipientStateCode !== null && isIndianStateCode(recipientStateCode)) {
    return { stateCode: recipientStateCode, supplyType: recipientStateCode === hospitalStateCode ? 'intra' : 'inter' }
  }
  return { stateCode: hospitalStateCode, supplyType: 'intra' }
}

export interface LineTax {
  cgstRateBp: number
  sgstRateBp: number
  igstRateBp: number
  cgstPaise: number
  sgstPaise: number
  igstPaise: number
  taxPaise: number
  totalPaise: number
}

/** roundHalfUp(amount × rateBp / 10000) with BigInt: (a × r × 2 + 10000) / 20000, floor. */
function taxOn(amount: bigint, rateBp: number): bigint {
  return (amount * BigInt(rateBp) * BigInt(2) + BigInt(10000)) / BigInt(20000)
}

export function lineTax(taxablePaise: number, gstRateBp: number, supplyType: SupplyType): LineTax {
  if (!Number.isSafeInteger(taxablePaise) || taxablePaise < 0) throw new RangeError('Taxable amount must be a non-negative whole number of paise')
  if (!(GST_RATES_BP as readonly number[]).includes(gstRateBp)) throw new RangeError('GST rate is not a valid slab')
  const a = BigInt(taxablePaise)
  let cgst = BigInt(0), sgst = BigInt(0), igst = BigInt(0)
  let cgstRateBp = 0, sgstRateBp = 0, igstRateBp = 0
  if (supplyType === 'intra') {
    cgstRateBp = sgstRateBp = gstRateBp / 2
    cgst = taxOn(a, cgstRateBp)
    sgst = taxOn(a, sgstRateBp)
  } else {
    igstRateBp = gstRateBp
    igst = taxOn(a, igstRateBp)
  }
  const tax = cgst + sgst + igst
  const total = a + tax
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Line total is out of range')
  return {
    cgstRateBp, sgstRateBp, igstRateBp,
    cgstPaise: Number(cgst), sgstPaise: Number(sgst), igstPaise: Number(igst),
    taxPaise: Number(tax), totalPaise: Number(total),
  }
}

export type DocumentTitle = 'Tax Invoice' | 'Bill of Supply' | 'Bill'

export function documentTitle(lineRatesBp: readonly number[], hospitalGstin: string | null): DocumentTitle {
  if (!hospitalGstin) return 'Bill'
  return lineRatesBp.some((r) => r > 0) ? 'Tax Invoice' : 'Bill of Supply'
}

/**
 * Frozen at finalisation into `invoices.snapshot` so a reprint never changes when the
 * hospital, patient or payer master is later edited. PHI: patient id, name, UHID and postal
 * address only (no national identity numbers, phone, email or date of birth).
 */
export interface InvoiceSnapshot {
  hospital: { legalName: string; gstin: string | null; stateCode: string; gstStateCode: string; address: string | null }
  patient: {
    id: string; name: string; uhid: string | null; addressLine1: string | null; addressLine2: string | null
    city: string | null; district: string | null; stateCode: string | null; pinCode: string | null
  }
  payer: { id: number; name: string; gstin: string | null; stateCode: string | null } | null
  context: { encounterId: number | null; admissionId: number | null; label: string }
}
