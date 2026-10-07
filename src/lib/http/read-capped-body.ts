// Byte-capped request body reader, shared by the CSV import routes (tariff import, code-system
// import). Moved verbatim from the tariff import route's `readCapped`: the declared content-length
// is checked first (a malformed one is refused), then bytes are counted while reading and the
// stream is cancelled as soon as the cap is passed, so an oversize body is never read in full.
// The body is held in memory only and never written to disk.

export type CappedBody = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' | 'bad_length' }

export async function readCappedBody(request: Request, maxBytes: number): Promise<CappedBody> {
  const declared = request.headers.get('content-length')
  if (declared !== null) {
    if (!/^\d{1,15}$/.test(declared.trim())) return { ok: false, reason: 'bad_length' }
    if (Number(declared) > maxBytes) return { ok: false, reason: 'too_large' }
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return { ok: false, reason: 'too_large' }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
  return { ok: true, bytes }
}
