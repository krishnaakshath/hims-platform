'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { fetchJson, sendJson } from '@/lib/client-fetch'
import { AddClientModal } from '@/components/AddClientModal'
import { EMPTY_REGISTRATION_FORM, type RegistrationFormState } from '@/components/registration/registration-form-state'
import { INDIAN_STATES } from '@/lib/india/reference'
import type { ShareQueueRow, SharePrefill } from '@/lib/queries/abdm-profile-shares'
import { SANDBOX_MOCK_LABEL } from './AbhaVerifyDialog'
import { formatIstTime } from '@/lib/india-time'

const GENDER: Record<string, string> = { M: 'male', F: 'female', O: 'other', T: 'transgender' }

export function prefillForm(p: SharePrefill): Partial<RegistrationFormState> {
  const state = p.stateName ? INDIAN_STATES.find((s) => s.label.toLowerCase() === p.stateName!.toLowerCase()) : undefined
  return {
    name: p.name ?? '', dob: p.dob ?? '', gender: p.gender ? GENDER[p.gender] ?? '' : '', phone: p.phone ?? '',
    addressLine1: p.addressLine ?? '', district: p.district ?? '', stateCode: state?.code ?? '', pinCode: p.pinCode ?? '',
    abhaMode: 'provided', abhaNumber: p.abhaNumber ?? '', abhaAddress: p.abhaAddress ?? '',
  }
}

export function ProfileShareQueue({ rows }: { rows: ShareQueueRow[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [registering, setRegistering] = useState<{ id: number; initial: Partial<RegistrationFormState> } | null>(null)

  // New shares arrive from the gateway at any time: refresh every 15 s.
  useEffect(() => {
    const t = setInterval(() => router.refresh(), 15_000)
    return () => clearInterval(t)
  }, [router])

  async function resolve(id: number, body: { action: 'linked' | 'dismissed' | 'registered'; patientId?: string }) {
    setBusy(id); setError(null)
    const r = await sendJson(`/api/abdm/shares/${id}`, 'POST', body)
    setBusy(null)
    if (!r.ok) { setError(r.error); return false }
    router.refresh()
    return true
  }

  async function startRegistration(id: number) {
    setBusy(id); setError(null)
    const r = await fetchJson<SharePrefill>(`/api/abdm/shares/${id}`)
    setBusy(null)
    if (!r.ok) { setError(r.error); return }
    setRegistering({ id, initial: prefillForm(r.data) })
  }

  if (rows.length === 0) return <p className="text-sm text-muted-foreground">No shared profiles are waiting.</p>
  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1">Token</th><th>Name</th><th>Gender / year</th><th>ABHA</th><th>Received</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-border">
              <td className="py-2 font-mono">{r.counterId}-{r.tokenNumber}</td>
              <td>{r.name ?? 'Not shared'}{r.isMock && <span className="ml-2 text-xs font-semibold text-amber-800">{SANDBOX_MOCK_LABEL}</span>}</td>
              <td>{[r.gender, r.yearOfBirth].filter(Boolean).join(' / ') || '-'}</td>
              <td><span className="font-mono">{r.abhaMasked ?? '-'}</span>{r.abhaAddress ? <span className="block text-xs text-muted-foreground">{r.abhaAddress}</span> : null}</td>
              <td className="text-xs">{formatIstTime(r.receivedAt)}</td>
              <td className="space-x-2 text-right">
                {r.existingPatientId ? (
                  <Button type="button" size="sm" disabled={busy === r.id} onClick={() => resolve(r.id, { action: 'linked', patientId: r.existingPatientId! })}>
                    Link to {r.existingPatientUhid ?? r.existingPatientId}
                  </Button>
                ) : (
                  <Button type="button" size="sm" disabled={busy === r.id} onClick={() => startRegistration(r.id)}>Register</Button>
                )}
                <Button type="button" size="sm" variant="outline" disabled={busy === r.id} onClick={() => resolve(r.id, { action: 'dismissed' })}>Dismiss</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {registering && (
        <AddClientModal
          initial={{ ...EMPTY_REGISTRATION_FORM, ...registering.initial }}
          onClose={() => setRegistering(null)}
          onRegistered={async (patientId) => { await resolve(registering.id, { action: 'registered', patientId }) }}
        />
      )}
    </div>
  )
}
