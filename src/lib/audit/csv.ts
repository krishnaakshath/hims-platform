// WS8 T12 (spec D19, pure): the audit-log CSV export. RFC 4180 with CRLF lines; every cell is
// quoted, and a value a spreadsheet would read as a formula (starting =, +, -, @, tab or CR) is
// prefixed with an apostrophe (formula injection). Patients appear by UHID, never by chart id.
import type { AuditLogEntry } from '@/lib/queries/audit-log'

export const AUDIT_CSV_HEADER = 'timestamp_ist,user,role,action,patient_uhid,details'

export function csvCell(v: string | null): string {
  let s = v ?? ''
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

const IST_OFFSET_MS = 330 * 60 * 1000

/** "2026-10-24 10:00:05" in IST. */
function istTimestamp(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

export function auditCsvLine(r: AuditLogEntry): string {
  return `${[istTimestamp(r.timestamp), r.userName, r.role, r.action, r.patientUhid, r.details].map(csvCell).join(',')}\r\n`
}

export function toAuditCsv(rows: AuditLogEntry[]): string {
  return `${AUDIT_CSV_HEADER}\r\n${rows.map(auditCsvLine).join('')}`
}
