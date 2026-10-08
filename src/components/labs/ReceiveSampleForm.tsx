'use client'
// SP5: lab-bench receipt by scanned or typed sample ID. A barcode/QR scanner types the ID and
// presses Enter, so the form submits on Enter; the server validates the check digit.
import { useState } from 'react'
import { sendJson } from '@/lib/client-fetch'
import { useRouter } from 'next/navigation'
import { displaySampleId, parseSampleId } from '@/lib/labs/sample-id'

export function ReceiveSampleForm() {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const typed = value.trim()
    if (!typed || busy) return
    setBusy(true)
    setMessage(null)
    const res = await sendJson<{ sampleId?: unknown } | null>('/api/lab-orders/receive', 'POST', { sampleId: typed })
    setBusy(false)
    if (res.ok) {
      const id = typeof res.data?.sampleId === 'string' ? res.data.sampleId : parseSampleId(typed)?.canonical ?? typed
      setMessage({ kind: 'ok', text: `Received ${displaySampleId(id)}` })
      setValue('')
      router.refresh()
    } else {
      setMessage({ kind: 'error', text: res.error })
    }
  }

  return (
    <form onSubmit={submit} className="mb-3 flex flex-wrap items-center gap-2">
      <label htmlFor="receive-sample-id" className="text-xs font-medium text-muted-foreground">Scan or type sample ID</label>
      <input
        id="receive-sample-id"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="L261008-0042-9"
        className="min-w-[12rem] flex-1 rounded-md border border-border px-3 py-1.5 font-mono text-sm"
        disabled={busy}
      />
      {message && (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={`w-full text-xs ${message.kind === 'error' ? 'text-destructive' : 'text-success'}`}>
          {message.text}
        </p>
      )}
    </form>
  )
}
