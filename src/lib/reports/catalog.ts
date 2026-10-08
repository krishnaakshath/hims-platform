// Wave I (P1-23): the report catalogue (pure, client-safe). One source for the
// ReportsSidebar, the /reports landing page, each report page's gate and the
// CSV export route's gate. Legacy leaves are the pre-Wave-I admin/crc reports.
import type { Role } from '@/lib/auth'
import { FINANCE_REPORT_ROLES, LAB_TAT_REPORT_ROLES, OPERATIONS_REPORT_ROLES, PHARMACY_REPORT_ROLES } from '@/lib/role-policy'

export type HospitalReportKey = 'opd' | 'ipd' | 'bed-occupancy' | 'discharges' | 'department-revenue' | 'collections' | 'tariff' | 'lab-tat' | 'pharmacy'

export interface ReportLeaf {
  key: string
  group: string
  label: string
  href: string
  roles: readonly Role[]
  description: string
}

export interface HospitalReportDef extends ReportLeaf {
  key: HospitalReportKey
  /** 'asOf' = a single date (the range's `to`), e.g. the tariff in force on a day. */
  dates: 'range' | 'asOf'
}

const OPS = 'Hospital operations'
const FIN = 'Finance'
const DIAG = 'Diagnostics & pharmacy'

export const HOSPITAL_REPORTS: readonly HospitalReportDef[] = [
  { key: 'opd', group: OPS, label: 'OPD statistics', href: '/reports/hospital/opd', roles: OPERATIONS_REPORT_ROLES, dates: 'range', description: 'OPD visits by department, doctor and day; new vs follow-up.' },
  { key: 'ipd', group: OPS, label: 'IPD statistics', href: '/reports/hospital/ipd', roles: OPERATIONS_REPORT_ROLES, dates: 'range', description: 'Admissions, discharges, average length of stay and daily census.' },
  { key: 'bed-occupancy', group: OPS, label: 'Bed occupancy', href: '/reports/hospital/bed-occupancy', roles: OPERATIONS_REPORT_ROLES, dates: 'range', description: 'Beds by ward now, and inpatient days against available bed-days.' },
  { key: 'discharges', group: OPS, label: 'Discharge register', href: '/reports/hospital/discharges', roles: OPERATIONS_REPORT_ROLES, dates: 'range', description: 'Every discharge with length of stay, doctor and last bed.' },
  { key: 'department-revenue', group: FIN, label: 'Department revenue', href: '/reports/hospital/department-revenue', roles: FINANCE_REPORT_ROLES, dates: 'range', description: 'Finalised invoice lines by department and service category.' },
  { key: 'collections', group: FIN, label: 'Collections by payment mode', href: '/reports/hospital/collections', roles: FINANCE_REPORT_ROLES, dates: 'range', description: 'Receipts, advances and refunds by mode, day and cashier.' },
  { key: 'tariff', group: FIN, label: 'Tariff price list', href: '/reports/hospital/tariff', roles: FINANCE_REPORT_ROLES, dates: 'asOf', description: 'Every active service with the rates in force on a date.' },
  { key: 'lab-tat', group: DIAG, label: 'Lab turnaround time', href: '/reports/hospital/lab-tat', roles: LAB_TAT_REPORT_ROLES, dates: 'range', description: 'Order-to-report times per test (median, average, 90th percentile).' },
  { key: 'pharmacy', group: DIAG, label: 'Pharmacy stock & dispensing', href: '/reports/hospital/pharmacy', roles: PHARMACY_REPORT_ROLES, dates: 'range', description: 'Stock against reorder levels and dispensing by medication and day.' },
]

const LEGACY_ROLES: readonly Role[] = ['admin', 'crc']
const LEGACY_LEAVES: readonly ReportLeaf[] = [
  { key: 'patients', group: 'Patients', label: 'All Patients', href: '/reports/patients', roles: LEGACY_ROLES, description: 'Every registered patient.' },
  { key: 'appointments', group: 'Appointments', label: 'All Appointments', href: '/reports/appointments/all', roles: LEGACY_ROLES, description: 'Every appointment.' },
  { key: 'unsigned-notes', group: 'Notes', label: 'Unsigned Notes', href: '/reports/notes/unsigned', roles: LEGACY_ROLES, description: 'Completed forms not yet classified.' },
  { key: 'encounters', group: 'Encounters', label: 'All Encounters', href: '/reports/encounters/all', roles: LEGACY_ROLES, description: 'Completed appointments with billing status.' },
  { key: 'insurance-collections', group: 'Claims', label: 'Insurance Collections', href: '/reports/claims/insurance-collections', roles: LEGACY_ROLES, description: 'Legacy insurance claims and payments.' },
]

export const REPORT_LEAVES: readonly ReportLeaf[] = [...HOSPITAL_REPORTS, ...LEGACY_LEAVES]

export function reportLeavesFor(role: Role): ReportLeaf[] {
  return REPORT_LEAVES.filter((l) => l.roles.includes(role))
}

export function hospitalReport(key: string): HospitalReportDef | null {
  return HOSPITAL_REPORTS.find((r) => r.key === key) ?? null
}
