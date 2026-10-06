'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { SignatureCapture } from '@/components/SignatureCapture'

const CONSENT_ATTESTATION = 'I attest that the information in this form is accurate and I consent to the terms described above.'

// Owns its own submitting/error state and its own fetch, matching how every
// other action component in this codebase (DischargeAdmissionModal,
// DispenseMedicationModal) works -- SignatureCapture itself is purely
// presentational and never calls fetch.
export function SignConsentFormAction({ patientId, formSubmissionId }: { patientId: string; formSubmissionId: number }) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function sign(typedName: string) {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/patients/${patientId}/form-submissions/${formSubmissionId}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ typedName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        setError(body?.error ?? 'Could not sign this form.')
        return
      }
      router.refresh()
    } catch {
      setError('Could not sign this form. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <SignatureCapture
      attestationLabel={CONSENT_ATTESTATION}
      submitLabel="Sign"
      submitting={submitting}
      error={error}
      onSign={sign}
    />
  )
}
