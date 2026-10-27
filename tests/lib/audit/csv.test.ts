// WS8 T12 (spec D19): formula-safe audit-log CSV.
import { describe, it, expect } from 'vitest'
import { csvCell, toAuditCsv, AUDIT_CSV_HEADER } from '@/lib/audit/csv'

describe('csvCell', () => {
  it('prefixes a formula-looking value with an apostrophe inside quotes', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`)
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(csvCell(`${lead}x`)).toBe(`"'${lead}x"`)
  })

  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('"plain"')
    expect(csvCell('say "hi", then\nleave')).toBe('"say ""hi"", then\nleave"')
  })

  it('writes null as an empty quoted cell', () => {
    expect(csvCell(null)).toBe('""')
  })
})

describe('toAuditCsv', () => {
  it('writes the header and one CRLF row per entry with the IST timestamp and UHID', () => {
    const csv = toAuditCsv([
      { id: 7, userName: 'Asha Rao', role: 'pharmacy', action: 'dispensed', patientUhid: 'UH000123', timestamp: new Date('2026-10-24T04:30:05Z'), details: '=cmd' },
      { id: 6, userName: 'Admin', role: null, action: 'viewed audit log', patientUhid: null, timestamp: new Date('2026-10-23T18:30:00Z'), details: null },
    ])
    expect(AUDIT_CSV_HEADER).toBe('timestamp_ist,user,role,action,patient_uhid,details')
    expect(csv.split('\r\n')).toEqual([
      'timestamp_ist,user,role,action,patient_uhid,details',
      '"2026-10-24 10:00:05","Asha Rao","pharmacy","dispensed","UH000123","\'=cmd"',
      '"2026-10-24 00:00:00","Admin","","viewed audit log","",""',
      '',
    ])
  })
})
