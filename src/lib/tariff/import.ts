// Pure validation of tariff CSV imports. Imports are all-or-nothing: when `issues` is not empty
// the caller must not commit `rows`. Issue messages never echo whole rows or the file.
import { parseRupeesToPaise } from '@/lib/money'
import { CsvSyntaxError, parseCsv } from './csv'
import {
  gstPercentToBp, rateCreateSchema, serviceCreateSchema,
  type RateCreateInput, type ServiceCategory, type ServiceCreateInput,
} from './validation'
import { findOverlap, normalizeWard, type DatedRate } from './versions'

export const MAX_IMPORT_ROWS = 5000
export const MAX_IMPORT_BYTES = 1_000_000
export const SERVICE_CSV_HEADERS = ['code', 'name', 'department_code', 'category', 'hsn_sac', 'gst_rate_percent', 'active'] as const
export const RATE_CSV_HEADERS = ['service_code', 'scope', 'department_code', 'payer_code', 'room_category_code', 'ward', 'amount_inr', 'valid_from', 'valid_to'] as const

export interface ImportLookups {
  departmentsByCode: Map<string, number>
  payersByCode: Map<string, number>          // keyed by payers.payer_id
  roomCategoriesByCode: Map<string, number>
  servicesByCode: Map<string, { id: number; category: ServiceCategory }>
  existingRates: DatedRate[]
}
export interface ImportIssue { line: number; column?: string; message: string }
export type ServiceImportRow = ServiceCreateInput & { isActive: boolean; existingId: number | null }

const ECHO_MAX = 40
function shown(v: string): string {
  return v.length > ECHO_MAX ? `${v.slice(0, ECHO_MAX)}…` : v
}

type Table = { rows: { line: number; cells: string[] }[] } | { issues: ImportIssue[] }

/** Size/row/header/syntax gate shared by both importers. */
function readTable(text: string, expected: readonly string[]): Table {
  if (text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) {
    return { issues: [{ line: 1, message: `File is larger than ${MAX_IMPORT_BYTES} bytes` }] }
  }
  let parsed
  try { parsed = parseCsv(text) } catch (e) {
    if (e instanceof CsvSyntaxError) return { issues: [{ line: e.line, message: e.message }] }
    throw e
  }
  const header = parsed.header.map((h) => h.trim().toLowerCase())
  if (header.length !== expected.length || header.some((h, i) => h !== expected[i])) {
    return { issues: [{ line: 1, message: `Header must be exactly: ${expected.join(',')}` }] }
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    return { issues: [{ line: 1, message: `File has more than ${MAX_IMPORT_ROWS} rows` }] }
  }
  return { rows: parsed.rows.map((r) => ({ line: r.line, cells: r.cells.map((c) => c.trim()) })) }
}

function toObject(headers: readonly string[], cells: string[]): Record<string, string> {
  return Object.fromEntries(headers.map((h, i) => [h, cells[i]]))
}

function parseActive(v: string): boolean | null {
  const s = v.toLowerCase()
  if (['yes', 'true', '1'].includes(s)) return true
  if (['no', 'false', '0'].includes(s)) return false
  return null
}

function schemaIssues(line: number, issues: { path: PropertyKey[]; message: string }[], columnOf: Record<string, string>): ImportIssue[] {
  return issues.map((i) => ({ line, column: columnOf[String(i.path[0])], message: i.message }))
}

export function validateServiceImport(text: string, lookups: ImportLookups): { rows: ServiceImportRow[]; issues: ImportIssue[] } {
  const table = readTable(text, SERVICE_CSV_HEADERS)
  if ('issues' in table) return { rows: [], issues: table.issues }
  const rows: ServiceImportRow[] = []
  const issues: ImportIssue[] = []
  const seen = new Set<string>()
  const columnOf = { code: 'code', name: 'name', departmentId: 'department_code', category: 'category', hsnSac: 'hsn_sac', gstRateBp: 'gst_rate_percent' }

  for (const { line, cells } of table.rows) {
    if (cells.length !== SERVICE_CSV_HEADERS.length) {
      issues.push({ line, message: `Expected ${SERVICE_CSV_HEADERS.length} columns, found ${cells.length}` })
      continue
    }
    const r = toObject(SERVICE_CSV_HEADERS, cells)
    const before = issues.length
    const code = r.code.toUpperCase()
    if (seen.has(code)) issues.push({ line, column: 'code', message: `Code ${shown(code)} appears more than once in the file` })
    seen.add(code)
    const departmentId = lookups.departmentsByCode.get(r.department_code.toUpperCase())
    if (departmentId === undefined) issues.push({ line, column: 'department_code', message: `Unknown department code ${shown(r.department_code.toUpperCase())}` })
    const gstRateBp = gstPercentToBp(r.gst_rate_percent)
    if (gstRateBp === null) issues.push({ line, column: 'gst_rate_percent', message: 'GST rate must be 0, 5, 12, 18, 28 or 40' })
    const isActive = parseActive(r.active)
    if (isActive === null) issues.push({ line, column: 'active', message: 'Active must be yes, no, true, false, 1 or 0' })
    if (issues.length > before) continue

    const parsed = serviceCreateSchema.safeParse({
      code, name: r.name, departmentId, category: r.category.toLowerCase(), hsnSac: r.hsn_sac, gstRateBp,
    })
    if (!parsed.success) { issues.push(...schemaIssues(line, parsed.error.issues, columnOf)); continue }
    rows.push({ ...parsed.data, isActive: isActive as boolean, existingId: lookups.servicesByCode.get(parsed.data.code)?.id ?? null })
  }
  return { rows, issues }
}

/**
 * Rates can only overlap when every dimension matches (sameDims), so overlap checks run within
 * one dimension group instead of against every rate: a 5,000-row file against tens of thousands
 * of live rates stays linear rather than pairwise.
 */
function dimsKey(r: DatedRate): string {
  return JSON.stringify([r.serviceId, r.scope, r.departmentId, r.payerId, r.roomCategoryId, r.ward === null ? null : normalizeWard(r.ward)])
}
function groupByDims<T extends DatedRate>(rates: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const r of rates) {
    const k = dimsKey(r)
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  return groups
}

export function validateRateImport(text: string, lookups: ImportLookups): { rows: RateCreateInput[]; issues: ImportIssue[] } {
  const table = readTable(text, RATE_CSV_HEADERS)
  if ('issues' in table) return { rows: [], issues: table.issues }
  const rows: RateCreateInput[] = []
  const issues: ImportIssue[] = []
  const existingByDims = groupByDims(lookups.existingRates)
  const acceptedByDims = new Map<string, (DatedRate & { line: number })[]>()
  const columnOf = {
    serviceId: 'service_code', scope: 'scope', departmentId: 'department_code', payerId: 'payer_code',
    roomCategoryId: 'room_category_code', ward: 'ward', amountPaise: 'amount_inr', validFrom: 'valid_from', validTo: 'valid_to',
  }

  for (const { line, cells } of table.rows) {
    if (cells.length !== RATE_CSV_HEADERS.length) {
      issues.push({ line, message: `Expected ${RATE_CSV_HEADERS.length} columns, found ${cells.length}` })
      continue
    }
    const r = toObject(RATE_CSV_HEADERS, cells)
    const before = issues.length
    const service = lookups.servicesByCode.get(r.service_code.toUpperCase())
    if (!service) issues.push({ line, column: 'service_code', message: `Unknown service code ${shown(r.service_code.toUpperCase())}` })
    const lookup = (col: string, map: Map<string, number>, label: string): number | undefined => {
      if (r[col] === '') return undefined
      const id = map.get(r[col].toUpperCase())
      if (id === undefined) issues.push({ line, column: col, message: `Unknown ${label} code ${shown(r[col].toUpperCase())}` })
      return id
    }
    const departmentId = lookup('department_code', lookups.departmentsByCode, 'department')
    const payerId = lookup('payer_code', lookups.payersByCode, 'payer')
    const roomCategoryId = lookup('room_category_code', lookups.roomCategoriesByCode, 'room category')
    const amountPaise = parseRupeesToPaise(r.amount_inr)
    if (amountPaise === null) issues.push({ line, column: 'amount_inr', message: 'Amount must be a rupee value such as 1250 or 1,250.50' })
    if (issues.length > before) continue

    const candidate = {
      serviceId: service!.id, scope: r.scope.toLowerCase(),
      ...(departmentId !== undefined && { departmentId }), ...(payerId !== undefined && { payerId }),
      ...(roomCategoryId !== undefined && { roomCategoryId }),
      ...(r.ward !== '' && { ward: r.ward }),
      amountPaise, validFrom: r.valid_from, ...(r.valid_to !== '' && { validTo: r.valid_to }),
    }
    const parsed = rateCreateSchema.safeParse(candidate)
    if (!parsed.success) { issues.push(...schemaIssues(line, parsed.error.issues, columnOf)); continue }

    const v = parsed.data
    const dated: DatedRate = {
      serviceId: v.serviceId, scope: v.scope, departmentId: v.departmentId ?? null, payerId: v.payerId ?? null,
      roomCategoryId: v.roomCategoryId ?? null, ward: v.ward === undefined ? null : normalizeWard(v.ward),
      validFrom: v.validFrom, validTo: v.validTo ?? null,
    }
    const key = dimsKey(dated)
    if (findOverlap(dated, existingByDims.get(key) ?? [])) {
      issues.push({ line, column: 'valid_from', message: 'Overlaps an existing rate for the same service and scope' })
      continue
    }
    const sameGroup = acceptedByDims.get(key) ?? []
    const earlier = findOverlap(dated, sameGroup)
    if (earlier) {
      issues.push({ line, column: 'valid_from', message: `Overlaps the rate on line ${(earlier as DatedRate & { line: number }).line} of this file` })
      continue
    }
    sameGroup.push({ ...dated, line })
    acceptedByDims.set(key, sameGroup)
    rows.push(v)
  }
  return { rows, issues }
}
