import { PatientAvatar } from '@/components/PatientAvatar'
import { PatientPortalSignOutButton } from '@/components/PatientPortalSignOutButton'

// Slim identity bar, same role as the staff app's TopBanner (persistent
// across every page, shows who's signed in and how to sign out) -- but
// without a logo, since that now lives in the sidebar, and without
// search/notifications, which a single patient's own portal doesn't need.
// Soft shadow instead of a hard border rule, matching the calm,
// consumer-facing register the rest of the portal uses.
export function PatientPortalTopBar({ name, dob, patientId }: { name: string; dob: string; patientId: string }) {
  return (
    <div className="flex items-center justify-between bg-white px-6 py-3 shadow-sm">
      <div className="flex items-center gap-2.5">
        <PatientAvatar name={name} size="sm" />
        <div>
          <p className="text-sm font-medium text-foreground">{name}</p>
          <p className="font-mono text-[11px] text-muted-foreground">DOB {dob} · {patientId}</p>
        </div>
      </div>
      <PatientPortalSignOutButton />
    </div>
  )
}
