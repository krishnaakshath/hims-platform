'use client'
// WL T11: first-run branding checklist shown to admins above every dashboard page (spec D18).
// Receives only the status object; both buttons post to the onboarding route and refresh.
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { BrandOnboardingStatus } from '@/lib/brand-resolve'

const LABELS: Record<BrandOnboardingStatus['items'][number]['key'], string> = {
  name: 'Set your hospital name',
  logo: 'Upload your logo',
  colour: 'Choose your accent colour',
  contact: 'Add a support phone or email',
  signin: 'Check how the sign-in page looks',
}

export function BrandOnboardingCard({ status }: { status: BrandOnboardingStatus }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const doneCount = status.items.filter((i) => i.done).length
  const open = status.items.filter((i) => !i.done)

  async function post(action: 'dismiss' | 'test_signin_done') {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/settings/branding/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) throw new Error('failed')
      router.refresh()
    } catch {
      setError('That did not save. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="brand-onboarding-title" className="mb-6 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="brand-onboarding-title" className="text-base font-semibold">Set up your hospital&apos;s branding</h2>
          <p className="text-sm text-muted-foreground">{doneCount} of {status.items.length} done</p>
        </div>
        <button type="button" disabled={busy} onClick={() => post('dismiss')} className="text-sm text-muted-foreground underline disabled:opacity-50">
          Dismiss
        </button>
      </div>
      <ul className="mt-3 space-y-2 text-sm">
        {open.map((i) => (
          <li key={i.key}>
            {i.key === 'signin' ? (
              <>
                <a href={i.href} target="_blank" rel="noopener" className="font-medium underline">{LABELS[i.key]}</a>
                <span className="text-muted-foreground"> Open it in a private window so you see it as a visitor does, then confirm below.</span>
                <div>
                  <button type="button" disabled={busy} onClick={() => post('test_signin_done')} className="mt-1 rounded border border-border px-2 py-1 text-sm disabled:opacity-50">
                    I tested the sign-in page
                  </button>
                </div>
              </>
            ) : (
              <Link href={i.href} className="font-medium underline">{LABELS[i.key]}</Link>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
    </section>
  )
}
