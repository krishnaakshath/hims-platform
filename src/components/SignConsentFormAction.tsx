'use client'
import { sendJson } from '@/lib/client-fetch'
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
      const res = await sendJson(`/api/patients/${patientId}/form-submissions/${formSubmissionId}/sign`, 'POST', { typedName })
      if (!res.ok) {
        setError(res.error)
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
