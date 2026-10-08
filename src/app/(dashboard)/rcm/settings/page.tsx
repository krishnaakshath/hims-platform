// /rcm/settings: hospital ROHINI / HFR identifiers (RCM_SETTINGS_ROLES = admin). No PHI.
import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { RCM_SETTINGS_ROLES } from '@/lib/role-policy'
import { getHospitalIdentifiers } from '@/lib/queries/rcm-payers'
import { HospitalIdentifiersForm } from '@/components/rcm/HospitalIdentifiersForm'

export default async function RcmSettingsPage() {
  const session = await requireSessionOrRedirect()
  if (!RCM_SETTINGS_ROLES.includes(session.role)) redirect('/')

  const ids = await getHospitalIdentifiers()
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-foreground">RCM settings</h1>
      <HospitalIdentifiersForm rohiniId={ids.rohiniId} hfrId={ids.hfrId} />
    </div>
  )
}
