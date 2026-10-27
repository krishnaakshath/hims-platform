'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { sendJson } from '@/lib/client-fetch'

// WS7 T4: admin-only prompt on /forms while any hospital pack form is missing.
export function InstallHospitalPackButton({ missing }: { missing: number }) {
  const router = useRouter()
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function install() {
    setInstalling(true)
    setError(null)
    const res = await sendJson('/api/form-templates/hospital-pack', 'POST', {})
    setInstalling(false)
    if (res.ok) router.refresh()
    else setError(res.error)
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/40 p-4">
      <p className="flex-1 text-sm text-foreground">
        {missing === 1 ? '1 form' : `${missing} forms`} from the hospital form pack (consents, admission, discharge, MLC and vaccination, in English, Hindi and Kannada) {missing === 1 ? 'is' : 'are'} not installed. Translations and consent wording are drafts until reviewed.
      </p>
      <button
        onClick={install}
        disabled={installing}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {installing ? 'Installing…' : 'Install hospital form pack'}
      </button>
      {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
    </div>
  )
}
