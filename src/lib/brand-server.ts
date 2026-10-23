// SERVER ONLY. The per-request brand (WL T4, spec §4.1, D11): the stored Settings > Branding
// values layered over the BRAND_* env brand. The DB snapshot is cached with `unstable_cache` under
// the 'brand-settings' tag (the project does not enable Cache Components; see
// node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md) and expired by
// `invalidateBrandCache()` after every branding write. The 300 s revalidate is a safety net for
// multi-replica self-hosting, where a tag invalidation reaches only the local instance.
//
// getBrand never throws: a DB failure is caught OUTSIDE the cached function (so it is never
// cached), logged by error class only (at most once a minute) and answered with the env brand.
// The snapshot carries blob URLs, so it never leaves this module: callers get a resolved Brand.
import { revalidateTag, unstable_cache } from 'next/cache'
import { cache } from 'react'
import { envBrand, type Brand, type PublicBrand } from '@/lib/brand'
import { resolveBrand, toPublicBrand } from '@/lib/brand-resolve'
import type { BrandAssetKind } from '@/lib/brand-snapshot'
import { getPrivateBlobBytes } from '@/lib/blob-store'
import { loadBrandSnapshot } from '@/lib/queries/brand-settings'

export const BRAND_CACHE_TAG = 'brand-settings'

const WARN_INTERVAL_MS = 60_000

const cachedSnapshot = unstable_cache(loadBrandSnapshot, ['brand-settings-v1'], { tags: [BRAND_CACHE_TAG], revalidate: 300 })

let lastWarnAt = Number.NEGATIVE_INFINITY

function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError'
}

function warnThrottled(message: string): void {
  const now = Date.now()
  if (now - lastWarnAt < WARN_INTERVAL_MS) return
  lastWarnAt = now
  console.warn(message)
}

/** The resolved brand for this request (React `cache` dedupes it within one render). Never throws. */
export const getBrand = cache(async (): Promise<Brand> => {
  try {
    return resolveBrand(envBrand, await cachedSnapshot())
  } catch (err) {
    warnThrottled(`[brand] settings read failed (${errorClass(err)})`)
    return resolveBrand(envBrand, null)
  }
})

export async function getPublicBrand(): Promise<PublicBrand> {
  return toPublicBrand(await getBrand())
}

/** Expire the cached snapshot now (call after a branding write commits, from a Route Handler). */
export function invalidateBrandCache(): void {
  revalidateTag(BRAND_CACHE_TAG, { expire: 0 })
}

/**
 * The current asset row (blob URL + sha256) of one kind, from the cached snapshot (so a favicon or
 * /branding request costs no query; after invalidateBrandCache the snapshot is fresh). Null when
 * there is none or the snapshot cannot be read (logged by error class only, throttled).
 */
export async function getBrandAssetRow(kind: BrandAssetKind): Promise<{ blobUrl: string; sha256: string } | null> {
  try {
    const snap = await cachedSnapshot()
    const row = snap?.assets.find((a) => a.kind === kind)
    return row ? { blobUrl: row.blobUrl, sha256: row.sha256 } : null
  } catch (err) {
    warnThrottled(`[brand] settings read failed (${errorClass(err)})`)
    return null
  }
}

/**
 * The stored PNG bytes of a brand asset (icon metadata routes, lab report logo), or null when there is none or
 * it cannot be read (the caller then renders the built-in icon). Logs the error class only.
 */
export async function readStoredBrandPng(kind: BrandAssetKind): Promise<Uint8Array | null> {
  const row = await getBrandAssetRow(kind)
  if (!row) return null
  try {
    return await getPrivateBlobBytes(row.blobUrl)
  } catch (err) {
    warnThrottled(`[brand] asset read failed (${errorClass(err)})`)
    return null
  }
}
