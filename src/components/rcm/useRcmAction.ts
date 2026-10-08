'use client'
// SP7: one JSON (or multipart) mutation against an /api/rcm route, then router.refresh(). A 4xx
// shows the route's authored `error`, plus readiness `items` when the route returns them.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { fetchJson, sendJson } from '@/lib/client-fetch'

export interface ActionItem { code: string; severity: 'block' | 'warn'; message: string }

export function useRcmAction() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<ActionItem[]>([])

  async function finish<T>(r: Awaited<ReturnType<typeof fetchJson<T>>>): Promise<T | null> {
    setBusy(false)
    if (!r.ok) {
      setError(r.error)
      const body = r.body as { items?: ActionItem[] } | undefined
      setItems(Array.isArray(body?.items) ? body.items : [])
      return null
    }
    setError(null)
    setItems([])
    router.refresh()
    return r.data
  }

  async function send<T = unknown>(url: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown): Promise<T | null> {
    setBusy(true)
    return finish<T>(await sendJson<T>(url, method, body))
  }

  async function upload<T = unknown>(url: string, form: FormData): Promise<T | null> {
    setBusy(true)
    return finish<T>(await fetchJson<T>(url, { method: 'POST', body: form }))
  }

  return { busy, error, items, send, upload, setError }
}
