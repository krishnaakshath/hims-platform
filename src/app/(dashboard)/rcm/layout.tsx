// /rcm/*: shows the missing-hospital-identifier notice (R13) above every RCM page. It does not
// gate: each page keeps its own role check. The session is read only for the role.
import { requireSessionOrRedirect } from '@/lib/auth'
import { RCM_ROLES, RCM_SETTINGS_ROLES } from '@/lib/role-policy'
import { getHospitalIdentifiers } from '@/lib/queries/rcm-payers'
import { HospitalIdentifiersNotice } from '@/components/rcm/HospitalIdentifiersNotice'

export default async function RcmLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSessionOrRedirect()
  if (!RCM_ROLES.includes(session.role)) return <>{children}</>
  const ids = await getHospitalIdentifiers()
  const missing: ('rohini' | 'hfr')[] = []
  if (!ids.rohiniId?.trim()) missing.push('rohini')
  if (!ids.hfrId?.trim()) missing.push('hfr')
  return (
    <>
      <HospitalIdentifiersNotice missing={missing} canEdit={RCM_SETTINGS_ROLES.includes(session.role)} />
      {children}
    </>
  )
}
