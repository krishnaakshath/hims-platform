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

/**
 * Fills every empty, enabled field under `root` with a plausible value (first
 * real option for selects) so a form's submit button becomes enabled.
 */
export async function fillAll(root: ParentNode = document.body) {
  const { fireEvent } = await import('@testing-library/react')
  root.querySelectorAll('select').forEach((el) => {
    if (el.disabled) return
    const opt = Array.from(el.options).find((o) => o.value !== '' && !o.disabled)
    if (opt && el.value === '') fireEvent.change(el, { target: { value: opt.value } })
  })
  root.querySelectorAll('textarea').forEach((el) => {
    if (!el.disabled && !el.readOnly && el.value === '') fireEvent.change(el, { target: { value: 'Test text' } })
  })
  root.querySelectorAll('input').forEach((el) => {
    if (el.disabled || el.readOnly || el.value !== '') return
    const t = el.type
    const value =
      t === 'number' ? '5'
      : t === 'date' ? '2026-10-08'
      : t === 'time' ? '10:00'
      : t === 'datetime-local' ? '2026-10-08T10:00'
      : t === 'email' ? 'a@b.co'
      : t === 'tel' ? '+919876543210'
      : t === 'password' ? 'Passw0rd!Passw0rd'
      : t === 'checkbox' || t === 'radio' || t === 'file' || t === 'hidden' ? null
      : 'Test value'
    if (value !== null) fireEvent.change(el, { target: { value } })
  })
}
