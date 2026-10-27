// WL T3: the brand data contract shared by the queries (src/lib/queries/brand-settings.ts), the
// cached loader and the resolver. Pure: constants and types only, no runtime imports, so client
// and proxy code can import it.
import type { BrandAssetRow, BrandSettingsRow } from '@/db/schema'

/** brand_assets.kind (CHECK brand_assets_kind_valid). icon_192 serves /icon/192 (lane ruling R3). */
export const BRAND_ASSET_KINDS = ['logo_light', 'logo_dark', 'icon_32', 'icon_180', 'icon_192', 'icon_512'] as const
export type BrandAssetKind = (typeof BRAND_ASSET_KINDS)[number]

/** The admin-editable brand_settings fields (camelCase), in form order. `revision` is not one of them. */
export const BRAND_EDITABLE_KEYS = [
  'displayName', 'tagline', 'supportEmail', 'supportPhone', 'accentColor', 'logoUrl', 'loginQuote', 'loginQuoteAttribution',
  'loginShowDepartmentList', 'portalName', 'printHeaderText', 'printFooterText', 'printSignatureLine', 'emailSignature', 'smsName',
] as const satisfies readonly (keyof BrandSettingsRow)[]
export type BrandEditableKey = (typeof BRAND_EDITABLE_KEYS)[number]

/** A full replace of the editable fields (validated by the Task 6 Zod schema); null = use the env/default layer. */
export type BrandSettingsInput = { [K in Exclude<BrandEditableKey, 'loginShowDepartmentList'>]: string | null } & {
  loginShowDepartmentList: boolean
}

/**
 * Everything the brand resolver needs, read in one go and safe to cache as JSON (ISO strings, no
 * Date). Asset rows carry the opaque blob URL: the snapshot stays on the server.
 */
export interface BrandSnapshot {
  settings: Omit<BrandSettingsRow, 'updatedAt' | 'onboardingTestSigninAt' | 'onboardingDismissedAt'> & {
    updatedAt: string
    onboardingTestSigninAt: string | null
    onboardingDismissedAt: string | null
  }
  assets: (Omit<BrandAssetRow, 'createdAt'> & { createdAt: string })[]
  billing: { legalName: string | null; address: string | null; gstin: string | null; rohiniId: string | null; hfrId: string | null } | null
  practice: { practiceName: string | null; practiceSite: string | null } | null
}
