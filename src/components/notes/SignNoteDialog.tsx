'use client'
import { useId, useState } from 'react'
import { sendJson } from '@/lib/client-fetch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

// WS7 T5 (spec D12). Kept in step with SIGN_NOTE_ATTESTATION in
// lib/queries/encounter-notes.ts (a server module this client file must not
// import); the server stores its own copy, never this one.
const ATTESTATION = 'I confirm I wrote or reviewed this note and that it is accurate.'

export type NoteReauthMethod = 'password' | 'totp' | null

// Signing a note: the signer's own typed name, the attestation tick, and
// re-authentication -- the account password, or a six-digit authenticator
// code for an account that signs in with Google and has no password.
export function SignNoteDialog({ patientId, noteId, reauthMethod, onClose, onSigned }: {
  patientId: string
  noteId: number
  reauthMethod: NoteReauthMethod
  onClose: () => void
  onSigned: () => void
}) {
  const [typedName, setTypedName] = useState('')
  const [attested, setAttested] = useState(false)
  const [secret, setSecret] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const secretId = useId()

  const secretOk = reauthMethod === 'totp' ? /^\d{6}$/.test(secret) : secret.length > 0
  const canSubmit = typedName.trim().length > 0 && attested && secretOk && !submitting

  async function submit() {
    setSubmitting(true)
    setError(null)
    const proof = reauthMethod === 'totp' ? { totpCode: secret } : { password: secret }
    const res = await sendJson(`/api/patients/${patientId}/notes/${noteId}/sign`, 'PUT', { typedName: typedName.trim(), attested: true, ...proof }, { passThrough: [401, 403, 429] })
    setSubmitting(false)
    if (res.ok) { onSigned(); return }
    // Never keep a refused password or code in the field.
    setSecret('')
    setError(res.error)
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Sign note</DialogTitle>
        </DialogHeader>
        {reauthMethod === null ? (
          <p className="text-sm text-muted-foreground">
            Your account has no password or authenticator app, so the system cannot confirm your identity to sign this note. Ask an administrator to set a password for your account.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor={nameId} className="block text-xs font-medium text-muted-foreground">Type your full name to sign</label>
              <input id={nameId} value={typedName} onChange={(e) => setTypedName(e.target.value)} aria-label="Your full name" autoComplete="off" maxLength={120} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
            </div>
            <label className="flex items-start gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} aria-label="Attestation" className="mt-0.5" />
              <span>{ATTESTATION}</span>
            </label>
            <div className="space-y-1">
              <label htmlFor={secretId} className="block text-xs font-medium text-muted-foreground">
                {reauthMethod === 'totp' ? 'Enter the six-digit code from your authenticator app' : 'Enter your password to confirm it is you'}
              </label>
              {reauthMethod === 'totp' ? (
                <input id={secretId} value={secret} onChange={(e) => setSecret(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-label="Authenticator code" inputMode="numeric" autoComplete="one-time-code" className="w-full rounded-md border border-border px-3 py-2 text-sm" />
              ) : (
                <input id={secretId} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} aria-label="Password" autoComplete="current-password" maxLength={200} className="w-full rounded-md border border-border px-3 py-2 text-sm" />
              )}
            </div>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          {reauthMethod !== null && <Button onClick={submit} disabled={!canSubmit}>Sign note</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
