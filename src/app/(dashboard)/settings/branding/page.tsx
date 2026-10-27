import { redirect } from 'next/navigation'
import { requireSessionOrRedirect } from '@/lib/auth'
import { BRAND_SETTINGS_ROLES } from '@/lib/role-policy'
import { getBrandingAdminPayload } from '@/lib/queries/brand-settings'
import { BrandingForm } from '@/components/settings/branding/BrandingForm'

// WL T8: /settings/branding (BRAND_SETTINGS_ROLES, admin). The gate runs before any data is read;
// a denied role goes back to /settings. Same payload as GET /api/settings/branding (no blob URLs).
export default async function BrandingSettingsPage() {
  const session = await requireSessionOrRedirect()
  if (!BRAND_SETTINGS_ROLES.includes(session.role)) redirect('/settings')
  const payload = await getBrandingAdminPayload()
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Branding</h1>
        <p className="text-sm text-muted-foreground">
          How the hospital appears on the sign-in page, in the app, on printouts and in messages. The preview updates as you type.
        </p>
      </div>
      <BrandingForm initial={payload} />
    </div>
  )
}
