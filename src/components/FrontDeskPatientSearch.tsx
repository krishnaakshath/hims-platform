'use client'
import { useEffect, useState } from 'react'

interface Match { id: string; name: string; dob: string; uhid: string | null }

function isMatchList(v: unknown): v is Match[] {
  return Array.isArray(v) && v.every((m) => m && typeof m === 'object' && typeof (m as Match).id === 'string' && typeof (m as Match).name === 'string')
}

// Registration duplicate check (Wave B P1-10: rendered by AddClientModal).
// Looks up by name + DOB once both are filled, and by the mobile number on
// its own (10+ digits). Advisory only -- it never blocks saving.
export function FrontDeskDuplicateWarning({ name, dob, phone = '' }: { name: string; dob: string; phone?: string }) {
  // Fetched results are kept separate from the "should we show anything" decision so the
  // effect never needs to setState synchronously just to clear stale matches when the inputs
  // become empty -- that's derived at render time below instead (avoids
  // react-hooks/set-state-in-effect).
  const [fetched, setFetched] = useState<{ key: string; matches: Match[] }>({ key: '', matches: [] })

  const params = new URLSearchParams()
  const trimmedName = name.trim()
  if (trimmedName && dob) { params.set('name', trimmedName); params.set('dob', dob) }
  if (phone.replace(/\D/g, '').length >= 10) params.set('phone', phone.trim())
  const key = params.toString()

  useEffect(() => {
    if (!key) return
    const controller = new AbortController()
    const timeout = setTimeout(async () => {
      try {
        const res = await fetch(`/api/front-desk/patient-lookup?${key}`, { signal: controller.signal })
        const body = res.ok ? await res.json().catch(() => null) : null
        setFetched({ key, matches: isMatchList(body) ? body : [] })
      } catch {
        // Advisory check: a failed lookup shows nothing rather than blocking registration.
      }
    }, 300)
    return () => { clearTimeout(timeout); controller.abort() }
  }, [key])

  const matches = key && fetched.key === key ? fetched.matches : []
  if (matches.length === 0) return null
  return (
    <div role="status" className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
      <p className="font-semibold">Possible existing patient — check before creating a new chart:</p>
      <ul className="mt-1 list-disc ps-4">
        {matches.map((m) => (
          <li key={m.id}>{m.name} · {m.uhid ?? 'no UHID'} · {m.id} · DOB {m.dob}</li>
        ))}
      </ul>
    </div>
  )
}
