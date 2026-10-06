'use client'
import { useEffect, useState } from 'react'

export function FrontDeskDuplicateWarning({ name, dob }: { name: string; dob: string }) {
  // Fetched results are kept separate from the "should we show anything" decision so the
  // effect never needs to setState synchronously just to clear stale matches when the inputs
  // become empty -- that's derived at render time below instead (avoids
  // react-hooks/set-state-in-effect).
  const [fetchedMatches, setFetchedMatches] = useState<{ id: string; name: string; dob: string }[]>([])

  useEffect(() => {
    if (!name || !dob) return
    const timeout = setTimeout(async () => {
      const res = await fetch(`/api/front-desk/patient-lookup?name=${encodeURIComponent(name)}&dob=${encodeURIComponent(dob)}`)
      if (res.ok) setFetchedMatches(await res.json())
    }, 300)
    return () => clearTimeout(timeout)
  }, [name, dob])

  const matches = name && dob ? fetchedMatches : []
  if (matches.length === 0) return null
  return (
    <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
      Possible existing patient: {matches.map((m) => `${m.name} (${m.id})`).join(', ')} — check before creating a new chart.
    </p>
  )
}
