// WL T3: white-label brand settings (singleton) and brand assets (spec §3, §4.1).
// Every write runs in one transaction with its audit row. Audit details carry field names, kinds
// and sizes only: never branding values, blob URLs or hashes.
import { asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { appSettings, billingSettings, brandAssets, brandSettings, type BrandSettingsRow } from '@/db/schema'
import { logAudit } from '@/lib/audit'
import type { Session } from '@/lib/auth'
import {
  BRAND_ASSET_KINDS, BRAND_EDITABLE_KEYS, type BrandAssetKind, type BrandSettingsInput, type BrandSnapshot,
} from '@/lib/brand-snapshot'
import type { WriteExecutor } from './executor'

export { BRAND_ASSET_KINDS, BRAND_EDITABLE_KEYS }
export type { BrandAssetKind, BrandSettingsInput, BrandSnapshot }

/** Every editable field null (env/default layer), the department list shown. */
const CLEARED: BrandSettingsInput = {
  displayName: null, tagline: null, supportEmail: null, supportPhone: null, accentColor: null, logoUrl: null,
  loginQuote: null, loginQuoteAttribution: null, loginShowDepartmentList: true, portalName: null, printHeaderText: null,
  printFooterText: null, printSignatureLine: null, emailSignature: null, smsName: null,
}

/** The row the migration inserts, used when the singleton is missing (a DB before the migration). */
const PRISTINE: BrandSettingsRow = {
  id: 1, revision: 0, ...CLEARED, onboardingTestSigninAt: null, onboardingDismissedAt: null, updatedAt: new Date(0), updatedByName: null,
}

const editable = (input: BrandSettingsInput): BrandSettingsInput =>
  Object.fromEntries(BRAND_EDITABLE_KEYS.map((k) => [k, input[k]])) as BrandSettingsInput

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)

export async function getBrandSettings(executor: WriteExecutor = getDb()): Promise<BrandSettingsRow> {
  const [row] = await executor.select().from(brandSettings).where(eq(brandSettings.id, 1)).limit(1)
  return row ?? { ...PRISTINE }
}

/** Settings, assets, billing identity and practice name in four narrow selects; JSON-safe for caching. */
export async function loadBrandSnapshot(): Promise<BrandSnapshot> {
  const db = getDb()
  const [settingsRows, assetRows, billingRows, practiceRows] = await Promise.all([
    db.select().from(brandSettings).where(eq(brandSettings.id, 1)).limit(1),
    db.select().from(brandAssets).orderBy(asc(brandAssets.kind)),
    db.select({
      legalName: billingSettings.legalName, address: billingSettings.address, gstin: billingSettings.gstin,
      rohiniId: billingSettings.rohiniId, hfrId: billingSettings.hfrId,
    }).from(billingSettings).where(eq(billingSettings.id, 1)).limit(1),
    db.select({ practiceName: appSettings.practiceName, practiceSite: appSettings.practiceSite })
      .from(appSettings).orderBy(asc(appSettings.id)).limit(1),
  ])
  const s = settingsRows[0] ?? PRISTINE
  return {
    settings: {
      ...s,
      updatedAt: s.updatedAt.toISOString(),
      onboardingTestSigninAt: iso(s.onboardingTestSigninAt),
      onboardingDismissedAt: iso(s.onboardingDismissedAt),
    },
    assets: assetRows.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    billing: billingRows[0] ?? null,
    practice: practiceRows[0] ?? null,
  }
}

/**
 * Full replace of the editable fields, guarded by the revision the admin loaded. A stale revision
 * changes nothing and writes no audit row.
 */
export async function updateBrandSettings(
  input: BrandSettingsInput, expectedRevision: number, session: Session,
): Promise<{ ok: true; revision: number; changed: string[] } | { ok: false; error: 'revision_conflict' }> {
  return getDb().transaction(async (tx) => {
    await tx.insert(brandSettings).values({ id: 1 }).onConflictDoNothing()
    const [current] = await tx.select().from(brandSettings).where(eq(brandSettings.id, 1)).for('update')
    const values = editable(input)
    const changed = BRAND_EDITABLE_KEYS.filter((k) => current[k] !== values[k])
    const [row] = await tx.update(brandSettings)
      .set({ ...values, revision: sql`${brandSettings.revision} + 1`, updatedAt: new Date(), updatedByName: session.name })
      .where(sql`${brandSettings.id} = 1 AND ${brandSettings.revision} = ${expectedRevision}`)
      .returning({ revision: brandSettings.revision })
    if (!row) return { ok: false as const, error: 'revision_conflict' as const }
    await logAudit(session, 'branding: updated settings', null, `fields=${changed.join(',')}`, tx)
    return { ok: true as const, revision: row.revision, changed: [...changed] }
  })
}

/**
 * Reset to defaults: nulls every editable field, shows the department list and deletes every asset
 * row (the stored blobs become unreachable: the asset route serves rows only). With a session the
 * revision advances and the reset is audited. `null` is the test helper: it restores the row the
 * migration inserts (revision 0, onboarding cleared) without an audit row.
 */
export async function resetBrandSettings(session: Session | null): Promise<{ revision: number }> {
  return getDb().transaction(async (tx) => {
    await tx.insert(brandSettings).values({ id: 1 }).onConflictDoNothing()
    await tx.select({ id: brandSettings.id }).from(brandSettings).where(eq(brandSettings.id, 1)).for('update')
    await tx.delete(brandAssets)
    const set = session
      ? { ...CLEARED, revision: sql`${brandSettings.revision} + 1`, updatedAt: new Date(), updatedByName: session.name }
      : { ...CLEARED, revision: 0, onboardingTestSigninAt: null, onboardingDismissedAt: null, updatedAt: new Date(), updatedByName: null }
    const [row] = await tx.update(brandSettings).set(set).where(eq(brandSettings.id, 1)).returning({ revision: brandSettings.revision })
    if (session) await logAudit(session, 'branding: reset to defaults', null, null, tx)
    return { revision: row.revision }
  })
}

export interface BrandAssetInput {
  source: 'upload' | 'derived'
  blobUrl: string
  sha256: string
  width: number
  height: number
  byteSize: number
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/**
 * Stores (or replaces) the asset of one kind. Without `tx` it runs in its own transaction and
 * audits `kind=… source=… bytes=… w=… h=…`. With `tx` the caller owns the transaction and writes
 * one audit row for the whole operation (an upload stores a logo plus derived icons).
 */
export async function putBrandAsset(kind: BrandAssetKind, data: BrandAssetInput, session: Session, tx?: Tx): Promise<void> {
  const write = async (ex: Tx) => {
    const values = {
      source: data.source, blobUrl: data.blobUrl, sha256: data.sha256, contentType: 'image/png',
      width: data.width, height: data.height, byteSize: data.byteSize, createdAt: new Date(), createdByName: session.name,
    }
    await ex.insert(brandAssets).values({ kind, ...values }).onConflictDoUpdate({ target: brandAssets.kind, set: values })
  }
  if (tx) return write(tx)
  await getDb().transaction(async (own) => {
    await write(own)
    await logAudit(session, 'branding: stored asset', null,
      `kind=${kind} source=${data.source} bytes=${data.byteSize} w=${data.width} h=${data.height}`, own)
  })
}

/** Deletes the asset rows of these kinds. Audited as `kinds=…` unless the caller passes its own `tx`. */
export async function deleteBrandAssets(kinds: readonly BrandAssetKind[], session: Session, tx?: Tx): Promise<void> {
  if (kinds.length === 0) return
  const write = (ex: Tx) => ex.delete(brandAssets).where(inArray(brandAssets.kind, [...kinds]))
  if (tx) { await write(tx); return }
  await getDb().transaction(async (own) => {
    await write(own)
    await logAudit(session, 'branding: removed asset', null, `kinds=${kinds.join(',')}`, own)
  })
}

/** The stored PNG for the public asset route; null when no asset of this kind exists. */
export async function getBrandAssetForServe(kind: BrandAssetKind): Promise<{ blobUrl: string; sha256: string } | null> {
  const [row] = await getDb().select({ blobUrl: brandAssets.blobUrl, sha256: brandAssets.sha256 })
    .from(brandAssets).where(eq(brandAssets.kind, kind)).limit(1)
  return row ?? null
}

/** Onboarding checklist: the admin confirmed a test sign-in, or dismissed the card. */
export async function recordOnboarding(action: 'test_signin_done' | 'dismiss', session: Session): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.insert(brandSettings).values({ id: 1 }).onConflictDoNothing()
    const now = new Date()
    await tx.update(brandSettings)
      .set(action === 'test_signin_done' ? { onboardingTestSigninAt: now } : { onboardingDismissedAt: now })
      .where(eq(brandSettings.id, 1))
    await logAudit(session, 'branding: onboarding', null, `action=${action}`, tx)
  })
}
