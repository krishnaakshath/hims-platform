import { Redis } from '@upstash/redis'

// Vercel's Upstash Redis integration provisions KV_REST_API_URL / KV_REST_API_TOKEN
// (not UPSTASH_REDIS_REST_URL/TOKEN, which is what Redis.fromEnv() looks for) —
// construct the client explicitly with those names.
function createRedis() {
  return new Redis({
    url: process.env.KV_REST_API_URL!,
    token: process.env.KV_REST_API_TOKEN!,
    // Without this, an Upstash-side outage or DNS hang leaves every cache
    // call (and the whole request awaiting it) stuck forever with no
    // rejection ever surfacing -- confirmed directly: one hung `del()` call
    // inside a route handler blocked an entire test run for over 90
    // minutes. A factory (not a single shared AbortSignal) so each request
    // gets its own fresh 5s budget, not one signal that's already expired
    // after the first call.
    signal: () => AbortSignal.timeout(5000),
  })
}

// A deployment (or a local dev/CI database) with no Redis configured simply
// has no cache: reads go straight to the database and invalidation is a no-op,
// instead of every cache call waiting out the request timeout. Rate limits,
// OTP and MFA are NOT part of this -- they need Redis and keep failing closed.
export function isCacheConfigured(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN)
}

let _redis: Redis | null = null
export function getRedis() {
  if (!_redis) _redis = createRedis()
  return _redis
}

// Error text from the Redis client can embed request details, so only the
// error class name is logged (e.g. "TimeoutError"), never the message.
function errKind(e: unknown): string {
  return e instanceof Error ? e.name : 'UnknownError'
}

/**
 * Read-through cache: returns the cached value if present, otherwise
 * calls `loader`, caches its result for `ttlSeconds`, and returns it.
 * Used to keep the Patients workbook and Patient Detail screens fast
 * without re-querying Postgres on every request.
 *
 * Fails open: a Redis error or timeout on read is a cache miss (the loader
 * hits the database), and a failed write-back is logged and ignored. Loader
 * errors still propagate.
 */
export async function getOrSetCache<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
  if (!isCacheConfigured()) return loader()
  try {
    const cached = await getRedis().get<T>(key)
    if (cached !== null && cached !== undefined) return cached
  } catch (e) {
    console.warn(`[cache] read failed for "${key}" (${errKind(e)}); falling back to the database`)
  }
  const fresh = await loader()
  try {
    await getRedis().set(key, fresh, { ex: ttlSeconds })
  } catch (e) {
    console.warn(`[cache] write failed for "${key}" (${errKind(e)}); value served uncached`)
  }
  return fresh
}

// Invalidation failures never throw to the caller (the write that triggered
// them already succeeded), but they are logged at error level because stale
// data can be served until the key's TTL expires.
export async function invalidateCache(key: string): Promise<void> {
  if (!isCacheConfigured()) return
  try {
    await getRedis().del(key)
  } catch (e) {
    console.error(`[cache] INVALIDATION FAILED for "${key}" (${errKind(e)}); stale data possible until TTL expiry`)
  }
}

/**
 * Deletes every cached key starting with `prefix` — for a cache keyed per
 * filter combination (e.g. reviewsListCacheKey), the write path can't know
 * every filter combination a reader might have cached under, so a single
 * invalidateCache(key) call for one specific key (like the no-filter view)
 * silently misses every other cached filter combination. Safe at this app's
 * real scale (a handful of keys per prefix, not thousands).
 */
export async function invalidateCacheByPrefix(prefix: string): Promise<void> {
  if (!isCacheConfigured()) return
  try {
    const keys = await getRedis().keys(`${prefix}*`)
    if (keys.length > 0) await getRedis().del(...keys)
  } catch (e) {
    console.error(`[cache] INVALIDATION FAILED for prefix "${prefix}" (${errKind(e)}); stale data possible until TTL expiry`)
  }
}

export function patientListCachePrefix(): string {
  return 'patients:list:'
}

export function patientListCacheKey(trialId: string | null): string {
  return `${patientListCachePrefix()}${trialId ?? 'all'}`
}

export function patientDetailCacheKey(anonId: string): string {
  return `patients:detail:${anonId}`
}

export function formTemplatesListCacheKey(): string {
  return 'form-templates:list'
}

export function formSubmissionsListCacheKey(filters: string): string {
  return `form-submissions:list:${filters}`
}

export function dashboardCacheKey(): string {
  return 'dashboard:data'
}

export function chargesListCacheKey(): string {
  return 'charges:list'
}

export function chargeDetailCacheKey(id: number): string {
  return `charges:detail:${id}`
}

export function insuranceClaimsListCacheKey(): string {
  return 'insurance-claims:list'
}

export function patientStatementsListCacheKey(): string {
  return 'patient-statements:list'
}

export function patientCollectionsListCacheKey(): string {
  return 'patient-collections:list'
}

export function arDashboardCacheKey(): string {
  return 'billing:ar-dashboard'
}

export function billingAnalyticsCacheKey(): string {
  return 'billing:analytics'
}

export function providersListCacheKey(): string {
  return 'providers:list'
}

export function workbookListCacheKey(): string {
  return 'workbook:list'
}

export function documentsListCacheKey(): string {
  return 'documents:list:all'
}

export function faxesListCacheKey(): string {
  return 'faxes:list:all'
}

export function allAppointmentsReportCacheKey(): string {
  return 'reports:appointments:all'
}

export function unsignedNotesReportCacheKey(): string {
  return 'reports:notes:unsigned'
}

export function allEncountersReportCacheKey(): string {
  return 'reports:encounters:all'
}

export function insuranceCollectionsReportCacheKey(): string {
  return 'reports:claims:insurance-collections'
}

export function broadcastsListCacheKey(): string {
  return 'broadcasts:list'
}

export function reviewsListCacheKey(filters: string): string {
  return `reviews:list:${filters}`
}

export function pipelineDashboardCacheKey(fromISO: string, toISO: string): string {
  return `pipeline-dashboard:${fromISO}:${toISO}`
}

export function pipelineDashboardTrendCacheKey(fromISO: string, toISO: string): string {
  return `pipeline-dashboard:trend:${fromISO}:${toISO}`
}
