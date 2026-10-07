'use client'
// Loaded code-system versions, grouped by kind, with "Make current" (admin page /coding/code-systems).
// Dates arrive pre-formatted from the server (IST), so SSR and hydration agree.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CODE_SYSTEM_KINDS, CODE_SYSTEM_LABEL, type CodeSystemKind } from '@/lib/coding/code-systems'

export interface CodeSystemView {
  id: number
  kind: CodeSystemKind
  version: string
  name: string
  isSample: boolean
  isCurrent: boolean
  codeCount: number
  licenceNote: string | null
  importedByName: string
  importedAtLabel: string
}

export function CodeSystemList({ systems }: { systems: CodeSystemView[] }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<{ kind: CodeSystemKind; message: string } | null>(null)

  async function makeCurrent(s: CodeSystemView) {
    setError(null)
    setBusyId(s.id)
    try {
      const res = await fetch(`/api/coding/code-systems/${s.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isCurrent: true }),
      })
      if (res.ok) { router.refresh(); return }
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setError({ kind: s.kind, message: body?.error ?? 'Could not change the current version.' })
    } catch {
      setError({ kind: s.kind, message: 'Could not reach the server. Check your connection and try again.' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-6">
      {CODE_SYSTEM_KINDS.map((kind) => {
        const label = CODE_SYSTEM_LABEL[kind]
        const versions = systems.filter((s) => s.kind === kind)
        const hasLicensed = versions.some((v) => !v.isSample)
        return (
          <section key={kind} aria-labelledby={`cs-${kind}`} className="rounded-lg border border-border">
            <h2 id={`cs-${kind}`} className="border-b border-border bg-secondary/40 px-4 py-2 text-sm font-semibold">{label}</h2>
            {versions.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {`No ${label} code set loaded. Coders cannot assign ${label} codes until an administrator loads one.`}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {versions.map((v) => {
                  const blocked = v.isSample && hasLicensed
                  return (
                    <li key={v.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{v.name}</span>
                          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{v.version}</code>
                          {v.isCurrent && <Badge>Current</Badge>}
                          {v.isSample && <Badge variant="outline">Sample</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {`${v.codeCount} ${v.codeCount === 1 ? 'code' : 'codes'} · imported by ${v.importedByName} on ${v.importedAtLabel}`}
                        </p>
                        {v.licenceNote && <p className="text-xs text-muted-foreground">{`Licence: ${v.licenceNote}`}</p>}
                      </div>
                      {!v.isCurrent && (
                        <Button
                          type="button" size="sm" variant="outline" disabled={busyId !== null || blocked}
                          title={blocked ? 'A sample code set cannot replace a licensed one' : undefined}
                          onClick={() => void makeCurrent(v)}
                        >
                          Make current
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {error?.kind === kind && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{error.message}</p>}
          </section>
        )
      })}
    </div>
  )
}
