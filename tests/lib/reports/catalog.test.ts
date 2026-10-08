import { describe, it, expect } from 'vitest'
import { ALL_ROLES, FINANCE_REPORT_ROLES, LAB_TAT_REPORT_ROLES, OPERATIONS_REPORT_ROLES, PHARMACY_REPORT_ROLES, REPORTS_ROLES } from '@/lib/role-policy'
import { HOSPITAL_REPORTS, REPORT_LEAVES, hospitalReport, reportLeavesFor } from '@/lib/reports/catalog'

// Wave I (P1-23): the hospital report catalogue is the single source for the
// sidebar, the /reports landing page, each page gate and the CSV route gate.
describe('hospital report catalogue', () => {
  it('lists the nine hospital reports with their gates', () => {
    expect(HOSPITAL_REPORTS.map((r) => [r.key, r.href, r.roles])).toEqual([
      ['opd', '/reports/hospital/opd', OPERATIONS_REPORT_ROLES],
      ['ipd', '/reports/hospital/ipd', OPERATIONS_REPORT_ROLES],
      ['bed-occupancy', '/reports/hospital/bed-occupancy', OPERATIONS_REPORT_ROLES],
      ['discharges', '/reports/hospital/discharges', OPERATIONS_REPORT_ROLES],
      ['department-revenue', '/reports/hospital/department-revenue', FINANCE_REPORT_ROLES],
      ['collections', '/reports/hospital/collections', FINANCE_REPORT_ROLES],
      ['tariff', '/reports/hospital/tariff', FINANCE_REPORT_ROLES],
      ['lab-tat', '/reports/hospital/lab-tat', LAB_TAT_REPORT_ROLES],
      ['pharmacy', '/reports/hospital/pharmacy', PHARMACY_REPORT_ROLES],
    ])
  })

  it('looks a report up by key, and nothing else', () => {
    expect(hospitalReport('opd')?.label).toBe('OPD statistics')
    expect(hospitalReport('nope')).toBeNull()
    expect(hospitalReport('__proto__')).toBeNull()
    expect(hospitalReport('toString')).toBeNull()
  })

  it('REPORTS_ROLES is exactly the roles that can open at least one report leaf', () => {
    const union = new Set(REPORT_LEAVES.flatMap((l) => l.roles))
    expect(new Set(REPORTS_ROLES)).toEqual(union)
  })

  it('gives each role only the leaves it may open, and none to a role outside REPORTS_ROLES', () => {
    for (const role of ALL_ROLES) {
      const leaves = reportLeavesFor(role)
      expect(leaves.every((l) => l.roles.includes(role))).toBe(true)
      expect(leaves.length > 0).toBe(REPORTS_ROLES.includes(role))
    }
    expect(reportLeavesFor('billing').map((l) => l.key)).toEqual(['department-revenue', 'collections', 'tariff'])
    expect(reportLeavesFor('labs').map((l) => l.key)).toEqual(['lab-tat'])
    expect(reportLeavesFor('pharmacy').map((l) => l.key)).toEqual(['pharmacy'])
  })

  it('keeps the legacy admin/crc leaves', () => {
    expect(reportLeavesFor('crc').map((l) => l.href)).toContain('/reports/patients')
    expect(reportLeavesFor('billing').map((l) => l.href)).not.toContain('/reports/patients')
  })
})
