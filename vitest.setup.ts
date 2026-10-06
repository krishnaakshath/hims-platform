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
