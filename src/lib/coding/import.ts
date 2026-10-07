// Validator for the code-system CSV import (SP6). Pure: callers commit only when `issues` is empty.
import { parseCsv, CsvSyntaxError } from '@/lib/tariff/csv'
import type { ImportIssue } from '@/lib/tariff/import'
import {
  CODE_PATTERN, CODE_SYSTEM_VERSION_PATTERN, isSampleVersion, normalizeCode, type CodeSystemKind,
} from '@/lib/coding/code-systems'

export const CODE_CSV_HEADERS = ['code', 'display', 'parent_code', 'selectable', 'active', 'effective_from', 'effective_to', 'sex', 'age_min_years', 'age_max_years', 'excludes'] as const

export const WEB_IMPORT_LIMITS = { maxBytes: 4_000_000, maxRows: 60_000 }
export const CLI_IMPORT_LIMITS = { maxBytes: 300_000_000, maxRows: 2_000_000 }
export const MAX_REPORTED_ISSUES = 200

export interface CodeImportMeta { kind: CodeSystemKind; version: string; name: string; licenceNote: string | null }

export interface CodeImportRow {
  code: string
  display: string
  parentCode: string | null
  selectable: boolean
  active: boolean
  effectiveFrom: string | null
  effectiveTo: string | null
  sexRestriction: 'male' | 'female' | null
  ageMinYears: number | null
  ageMaxYears: number | null
  excludes: string[]
}

const MAX_PARENT_STEPS = 20
const MAX_EXCLUDES = 50
const EXCLUDE_PATTERN = /^[A-Z0-9][A-Z0-9.\-]{0,19}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/

function parseFlag(v: string): boolean | null {
  const s = v.toLowerCase()
  if (s === '') return true
  if (['yes', 'true', '1'].includes(s)) return true
  if (['no', 'false', '0'].includes(s)) return false
  return null
}

function parseIsoDate(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null
}

function parseAge(v: string): number | null {
  if (!/^\d{1,3}$/.test(v)) return null
  const n = Number(v)
  return n >= 0 && n <= 150 ? n : null
}

export function validateCodeSystemImport(
  text: string,
  meta: CodeImportMeta,
  limits: { maxBytes: number; maxRows: number },
): { rows: CodeImportRow[]; issues: ImportIssue[]; isSample: boolean } {
  const isSample = isSampleVersion(meta.version)
  const issues: ImportIssue[] = []
  let truncated = false
  const add = (line: number, message: string, column?: string) => {
    if (issues.length >= MAX_REPORTED_ISSUES) { truncated = true; return }
    issues.push(column === undefined ? { line, message } : { line, column, message })
  }
  const finish = (rows: CodeImportRow[]) => {
    if (truncated) issues.push({ line: 1, message: 'More problems were found; fix these first' })
    return { rows: issues.length === 0 ? rows : [], issues, isSample }
  }

  if (!CODE_SYSTEM_VERSION_PATTERN.test(meta.version)) add(1, 'Version must be 1-40 letters, digits, dot, dash or underscore', 'version')
  const name = meta.name.trim()
  if (name.length < 1 || name.length > 120) add(1, 'Name must be 1-120 characters', 'name')
  const note = meta.licenceNote?.trim() ?? ''
  if (!isSample && (note.length < 1 || note.length > 500)) add(1, 'A licence note (1-500 characters) is required for non-sample code sets', 'licenceNote')
  if (isSample && note.length > 500) add(1, 'Licence note must be at most 500 characters', 'licenceNote')

  if (text.length > limits.maxBytes || new TextEncoder().encode(text).length > limits.maxBytes) {
    add(1, `File is larger than ${limits.maxBytes} bytes`)
    return finish([])
  }
  let parsed
  try { parsed = parseCsv(text) } catch (e) {
    if (e instanceof CsvSyntaxError) { add(e.line, e.message); return finish([]) }
    throw e
  }
  const header = parsed.header.map((h) => h.trim().toLowerCase())
  if (header.length !== CODE_CSV_HEADERS.length || header.some((h, i) => h !== CODE_CSV_HEADERS[i])) {
    add(1, `Header must be exactly: ${CODE_CSV_HEADERS.join(',')}`)
    return finish([])
  }
  if (parsed.rows.length > limits.maxRows) {
    add(1, `File has more than ${limits.maxRows} rows`)
    return finish([])
  }
  if (parsed.rows.length === 0) {
    add(1, 'File has no codes')
    return finish([])
  }

  const rows: CodeImportRow[] = []
  const lineOf = new Map<string, number>()
  const parentOf = new Map<string, string | null>()
  const parentLine: { code: string; line: number }[] = []

  for (const rec of parsed.rows) {
    const { line } = rec
    if (rec.cells.length !== CODE_CSV_HEADERS.length) {
      add(line, `Row must have ${CODE_CSV_HEADERS.length} columns`)
      continue
    }
    const [rCode, rDisplay, rParent, rSel, rAct, rFrom, rTo, rSex, rMin, rMax, rExc] = rec.cells.map((c) => c.trim())
    let ok = true
    const fail = (message: string, column: string) => { ok = false; add(line, message, column) }

    const code = normalizeCode(rCode)
    if (!CODE_PATTERN[meta.kind].test(code)) fail('Code does not match the format for this code system', 'code')
    else if (lineOf.has(code)) fail('Duplicate code', 'code')
    else lineOf.set(code, line)

    if (rDisplay.length < 1 || rDisplay.length > 500) fail('Display must be 1-500 characters', 'display')
    else if (CONTROL_CHARS.test(rDisplay)) fail('Display may not contain control characters', 'display')
    else if (/^[=+\-@]/.test(rDisplay)) fail('Display may not start with = + - or @', 'display')
    else if (isSample && !rDisplay.startsWith('SAMPLE')) fail('Sample code sets must label every display SAMPLE', 'display')

    const parentCode = rParent === '' ? null : normalizeCode(rParent)
    if (parentCode !== null && parentCode === code) fail('A code cannot be its own parent', 'parent_code')

    const selectable = parseFlag(rSel)
    if (selectable === null) fail('Selectable must be yes/no, true/false or 1/0', 'selectable')
    const active = parseFlag(rAct)
    if (active === null) fail('Active must be yes/no, true/false or 1/0', 'active')

    const effectiveFrom = rFrom === '' ? null : parseIsoDate(rFrom)
    if (rFrom !== '' && effectiveFrom === null) fail('Not a real date (use YYYY-MM-DD)', 'effective_from')
    const effectiveTo = rTo === '' ? null : parseIsoDate(rTo)
    if (rTo !== '' && effectiveTo === null) fail('Not a real date (use YYYY-MM-DD)', 'effective_to')
    if (effectiveFrom !== null && effectiveTo !== null && effectiveTo < effectiveFrom) fail('effective_to is before effective_from', 'effective_to')

    let sexRestriction: 'male' | 'female' | null = null
    const sx = rSex.toLowerCase()
    if (sx === 'm' || sx === 'male') sexRestriction = 'male'
    else if (sx === 'f' || sx === 'female') sexRestriction = 'female'
    else if (sx !== '') fail('Sex must be empty, m/male or f/female', 'sex')

    const ageMin = rMin === '' ? null : parseAge(rMin)
    if (rMin !== '' && ageMin === null) fail('Age must be a whole number from 0 to 150', 'age_min_years')
    const ageMax = rMax === '' ? null : parseAge(rMax)
    if (rMax !== '' && ageMax === null) fail('Age must be a whole number from 0 to 150', 'age_max_years')
    if (ageMin !== null && ageMax !== null && ageMin > ageMax) fail('age_min_years is above age_max_years', 'age_max_years')

    const excludes: string[] = []
    if (rExc !== '') {
      const parts = rExc.split(';').map(normalizeCode).filter((p) => p !== '')
      if (parts.length > MAX_EXCLUDES) fail(`At most ${MAX_EXCLUDES} excludes entries`, 'excludes')
      else if (parts.some((p) => !EXCLUDE_PATTERN.test(p))) fail('An excludes entry has an invalid format', 'excludes')
      else excludes.push(...parts)
    }

    if (!ok) continue
    parentOf.set(code, parentCode)
    parentLine.push({ code, line })
    rows.push({
      code, display: rDisplay, parentCode, selectable: selectable as boolean, active: active as boolean,
      effectiveFrom, effectiveTo, sexRestriction, ageMinYears: ageMin, ageMaxYears: ageMax, excludes,
    })
  }

  // Parent references and loops are checked across the whole file (valid rows only).
  const known = new Set(lineOf.keys())
  for (const { code, line } of parentLine) {
    const parent = parentOf.get(code) ?? null
    if (parent === null) continue
    if (!known.has(parent)) { add(line, 'Parent code is not in this file', 'parent_code'); continue }
    let cur: string | null | undefined = parent
    let steps = 0
    while (cur !== null && cur !== undefined && steps < MAX_PARENT_STEPS) { cur = parentOf.get(cur); steps++ }
    if (cur !== null && cur !== undefined) add(line, 'Parent chain loops', 'parent_code')
  }
  return finish(rows)
}
