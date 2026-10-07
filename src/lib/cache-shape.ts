// Pure helpers for values stored by getOrSetCache (src/lib/cache.ts). Kept in
// their own module (no Redis import) so loaders can use datesToIso() even in
// tests that replace '@/lib/cache' with a mock.

/** True when T (at any depth) contains a Date. */
export type HasDate<T> = T extends Date
  ? true
  : T extends readonly (infer U)[]
    ? HasDate<U>
    : T extends object
      ? true extends { [K in keyof T]-?: HasDate<T[K]> }[keyof T] ? true : false
      : false

/** T with every Date (at any depth) replaced by its ISO string. */
export type DatesToIso<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? DatesToIso<U>[]
    : T extends object
      ? { [K in keyof T]: DatesToIso<T[K]> }
      : T

/**
 * Deep-copies a value with every Date replaced by its ISO string -- the shape
 * a cached value has after Redis's JSON round-trip -- so a cache-backed
 * loader returns ONE shape whether the read was a hit or a miss.
 */
export function datesToIso<T>(value: T): DatesToIso<T> {
  if (value instanceof Date) return value.toISOString() as DatesToIso<T>
  if (Array.isArray(value)) return value.map((v) => datesToIso(v)) as DatesToIso<T>
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = datesToIso(v)
    return out as DatesToIso<T>
  }
  return value as DatesToIso<T>
}

/** Wraps a getOrSetCache loader so its value is datesToIso()-normalised. */
export function isoDates<T>(loader: () => Promise<T>): () => Promise<DatesToIso<T>> {
  return async () => datesToIso(await loader())
}
