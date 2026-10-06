/**
 * Like `Promise.all(items.map(fn))`, but never runs more than `limit` calls
 * of `fn` at once. Results keep input order; the first rejection rejects the
 * whole call (calls already started are left to settle on their own).
 *
 * For fan-outs over a whole table (e.g. the workbook export): unbounded,
 * each item can hold a Postgres pool connection, so one request could take
 * all of them and starve every other request into the pool's connection
 * timeout.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`mapWithConcurrency: limit must be a positive integer, got ${limit}`)
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
