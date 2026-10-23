import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

// @testing-library/react doesn't auto-register DOM cleanup for Vitest the way
// it does for Jest — without this, multiple `it()` blocks in the same
// component test file accumulate renders in the same jsdom document, causing
// spurious "multiple elements found" failures in later tests.
afterEach(() => cleanup())

// Route handler modules are invoked directly in tests (not through an actual
// Next.js HTTP request), so `next/headers`'s `cookies()` has no request-scoped
// async-local-storage context to read and throws "called outside a request
// scope". Stub it with an empty, no-op cookie store so `getSession()` (and any
// future route handler that reads cookies) resolves to "no session" instead
// of throwing — matching real unauthenticated-request behavior.
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}))

// WL T4: `next/cache` needs Next's request/incremental-cache context, which tests (calling route
// handlers, layouts and getBrand directly) do not have. `unstable_cache` passes straight through
// (every call reads the DB, so a stored brand is visible at once) and the invalidation APIs are
// no-op spies. Tests that assert on the cache wiring (tests/lib/brand-server.test.ts) doMock it.
vi.mock('next/cache', () => ({
  unstable_cache: <T extends (...args: never[]) => Promise<unknown>>(fn: T) => fn,
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  updateTag: vi.fn(),
}))

// WL T4: the root layout and the icon/manifest metadata routes `await connection()` (next/server)
// to render per request; outside a Next request scope it throws, so tests get a resolved no-op.
// Everything else in next/server is the real module.
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, connection: async () => undefined }
})
