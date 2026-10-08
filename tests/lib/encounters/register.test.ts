import { describe, it, expect } from 'vitest'
import {
  encounterRegisterCsv, parseRegisterFilters, registerQueryString, REGISTER_MAX_SPAN_DAYS, type EncounterRegisterRow,
} from '@/lib/encounters/register'

// Wave F P1-04: the OPD register's filter parsing and CSV export (pure).
const TODAY = '2026-10-08'

describe('parseRegisterFilters', () => {
  it('defaults to today, OPD, every department/doctor/status', () => {
    expect(parseRegisterFilters({}, TODAY)).toEqual({
      ok: true,
      filters: { from: TODAY, to: TODAY, type: 'opd', status: null, departmentId: null, providerId: null },
    })
  })

  it('accepts a full, valid filter set (the first value of a repeated key)', () => {
    expect(parseRegisterFilters({ from: '2026-10-01', to: '2026-10-07', type: 'all', status: 'completed', department: '3', doctor: ['12', '13'] }, TODAY)).toEqual({
      ok: true,
      filters: { from: '2026-10-01', to: '2026-10-07', type: null, status: 'completed', departmentId: 3, providerId: 12 },
    })
  })

  it('treats empty strings as "not set"', () => {
    const r = parseRegisterFilters({ from: '', to: '', type: '', status: '', department: '', doctor: '' }, TODAY)
    expect(r).toEqual({ ok: true, filters: { from: TODAY, to: TODAY, type: 'opd', status: null, departmentId: null, providerId: null } })
  })

  it.each([
    [{ from: '2026-02-30' }, 'date'],
    [{ from: '08-10-2026' }, 'date'],
    [{ to: 'yesterday' }, 'date'],
    [{ from: '2026-10-08', to: '2026-10-01' }, 'range'],
    [{ status: 'done' }, 'status'],
    [{ type: 'er' }, 'type'],
    [{ department: 'x' }, 'department'],
    [{ doctor: '-1' }, 'doctor'],
    [{ doctor: '99999999999' }, 'doctor'],
  ])('rejects %o', (sp, field) => {
    const r = parseRegisterFilters(sp as Record<string, string>, TODAY)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.field).toBe(field)
  })

  it(`caps the span at ${REGISTER_MAX_SPAN_DAYS} days`, () => {
    expect(parseRegisterFilters({ from: '2026-01-01', to: '2026-10-08' }, TODAY)).toMatchObject({ ok: false, field: 'range' })
    expect(parseRegisterFilters({ from: '2026-07-09', to: '2026-10-08' }, TODAY).ok).toBe(true)
  })
})

describe('registerQueryString', () => {
  it('round-trips through parseRegisterFilters', () => {
    const filters = { from: '2026-10-01', to: '2026-10-07', type: null, status: 'cancelled' as const, departmentId: 3, providerId: null }
    const qs = registerQueryString(filters)
    const sp = Object.fromEntries(new URLSearchParams(qs))
    expect(parseRegisterFilters(sp, TODAY)).toEqual({ ok: true, filters })
  })
})

const ROW: EncounterRegisterRow = {
  id: 9, encounterDate: '2026-10-08', opdToken: 4, encounterType: 'opd', visitType: 'follow_up', status: 'completed',
  checkedInAt: new Date('2026-10-08T03:45:00Z'), completedAt: new Date('2026-10-08T05:10:00Z'),
  patientId: 'RD-0042', patientName: 'Asha Rao', uhid: 'UH-000042', ageYears: 46, gender: 'female',
  departmentName: 'General Medicine', doctorName: 'Dr. Meera Iyer, MD',
}

describe('encounterRegisterCsv', () => {
  it('writes a header and one CRLF line per row with IST times', () => {
    const csv = encounterRegisterCsv([ROW])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Date,Token,UHID,Patient,Age,Sex,Type,Visit,Department,Doctor,Status,Checked in (IST),Completed (IST)')
    expect(lines[1]).toBe('8 Oct 2026,4,UH-000042,Asha Rao,46,Female,OPD,Follow-up,General Medicine,"Dr. Meera Iyer, MD",Completed,"8 Oct 2026, 9:15 am","8 Oct 2026, 10:40 am"')
  })

  it('quotes embedded quotes and neutralises spreadsheet formulas', () => {
    const csv = encounterRegisterCsv([{ ...ROW, patientName: '=HYPERLINK("x")', departmentName: '+91 ward', doctorName: 'Dr "Q"', opdToken: null, uhid: null, completedAt: null, gender: null }])
    const line = csv.split('\r\n')[1]
    expect(line).toContain(`"'=HYPERLINK(""x"")"`)
    expect(line).toContain(`'+91 ward`)
    expect(line).toContain('"Dr ""Q"""')
    expect(line.startsWith('8 Oct 2026,,,')).toBe(true)
  })

  it('never carries a phone, address or national-ID column', () => {
    expect(encounterRegisterCsv([]).split('\r\n')[0]).not.toMatch(/phone|mobile|address|aadhaar|abha/i)
  })
})
