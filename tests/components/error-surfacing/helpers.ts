// Shared helpers for the Wave H error-surfacing component tests: a mocked
// fetch that answers with a chosen status, and the fixed client messages.
import { vi } from 'vitest'
export { CLIENT_ERROR_MESSAGES } from '@/lib/client-fetch'

export function mockFetch(status: number, body: unknown = {}) {
  const fn = vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
  vi.stubGlobal('fetch', fn)
  return fn
}

export function mockFetchReject() {
  const fn = vi.fn(async () => { throw new TypeError('Failed to fetch') })
  vi.stubGlobal('fetch', fn)
  return fn
}
