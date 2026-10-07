// Client helpers shared by the tariff screens. Every mutation goes through the /api/tariff routes
// and hands back the server's own error text so the user sees e.g. the 409 overlap message.

export type ApiResult<T = unknown> = { ok: true; data: T } | { ok: false; status: number; error: string }

export async function sendJson<T = unknown>(url: string, method: 'POST' | 'PUT' | 'PATCH', body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = await res.json().catch(() => null)
    if (res.ok) return { ok: true, data: data as T }
    const error = data && typeof data.error === 'string' && data.error ? data.error : 'Something went wrong. Please try again.'
    return { ok: false, status: res.status, error }
  } catch {
    return { ok: false, status: 0, error: 'Could not reach the server. Check your connection and try again.' }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-10-07' -> '7 Oct 2026'. Pure string work (no Intl/toLocale), so SSR and hydration always agree. */
export function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return '—'
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? '—'} ${m[1]}`
}

export const FIELD_CLASS = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm'
