import {
  ClipboardCheck, Receipt, Stethoscope, ClipboardList, Pill, TestTube2, ShieldCheck,
} from 'lucide-react'
import type { StaffPortal } from '@/components/StaffLoginForm'

// Colors match the exact per-role hues already established in
// StaffManagementPanel.tsx's ROLE_BADGE -- same role, same color, everywhere
// in the app (staff directory badges, this picker, each login door).
export const STAFF_PORTALS: StaffPortal[] = [
  { key: 'frontdesk', label: 'Front Desk', description: 'Registration, check-in, and scheduling', icon: ClipboardCheck, iconBg: 'bg-emerald-500/10', iconText: 'text-emerald-700' },
  { key: 'billing', label: 'Billing', description: 'Claims, collections, and statements', icon: Receipt, iconBg: 'bg-amber-500/10', iconText: 'text-amber-700' },
  { key: 'pi', label: 'Doctor / PI', description: 'Patients, charts, and prescriptions', icon: Stethoscope, iconBg: 'bg-primary/10', iconText: 'text-primary' },
  { key: 'crc', label: 'Coordinator', description: 'Screening, forms, and the workbook', icon: ClipboardList, iconBg: 'bg-sky-500/10', iconText: 'text-sky-700' },
  { key: 'pharmacy', label: 'Pharmacy', description: 'Dispensing and medication stock', icon: Pill, iconBg: 'bg-violet-500/10', iconText: 'text-violet-700' },
  { key: 'labs', label: 'Labs', description: 'Collections, results, and imaging', icon: TestTube2, iconBg: 'bg-rose-500/10', iconText: 'text-rose-700' },
  { key: 'admin', label: 'Admin', description: 'Practice-wide oversight and settings', icon: ShieldCheck, iconBg: 'bg-accent/10', iconText: 'text-accent' },
]

export function getStaffPortal(key: string): StaffPortal | undefined {
  return STAFF_PORTALS.find((p) => p.key === key)
}
