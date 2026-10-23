// SERVER ONLY. Local-disk blob driver: dev and self-hosted fallback when no Vercel Blob store
// exists. The returned url is opaque ("local:" + a safe key), never a filesystem path. On-disk
// names are a hash of the key; the content type lives in a sidecar file together with a digest of
// the data. Writes go to a unique temp name then rename (data first, sidecar last), and a read
// whose sidecar is missing or whose digest does not match the data is null, so a torn pair
// (bytes of one write with the content type of another) is never served.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface BlobDriver {
  put(path: string, body: Uint8Array, contentType: string): Promise<{ url: string }>
  get(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
}

/** A failed disk write. Carries only the error code: the message of an fs error embeds the path. */
export class LocalBlobWriteError extends Error {
  constructor(code: string) {
    super(`Local blob write failed (${code})`)
    this.name = 'LocalBlobWriteError'
  }
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

const SAFE_KEY = /^[A-Za-z0-9._\-/]+$/

/** Validates a caller-supplied blob path and returns it as the key. Throws on anything unsafe. */
function toKey(p: string): string {
  if (typeof p !== 'string' || p === '' || p.includes('\0') || p.includes('\\') || p.startsWith('/')) {
    throw new Error('Invalid blob path')
  }
  const segs = p.split('/')
  if (segs.some((s) => s === '' || s === '.' || s === '..') || !SAFE_KEY.test(p)) throw new Error('Invalid blob path')
  return p
}

export function createLocalBlobDriver(rootDir: string): BlobDriver {
  const root = path.resolve(rootDir)

  function locate(key: string): { data: string; meta: string } {
    const name = createHash('sha256').update(key).digest('hex')
    const data = path.resolve(root, name.slice(0, 2), name)
    const meta = `${data}.meta`
    for (const f of [data, meta]) {
      if (!f.startsWith(root + path.sep)) throw new Error('Invalid blob path')
    }
    return { data, meta }
  }

  return {
    async put(p, body, contentType) {
      const key = toKey(p)
      const { data, meta } = locate(key)
      const tmpData = `${data}.${randomUUID()}.tmp`
      const tmpMeta = `${meta}.${randomUUID()}.tmp`
      try {
        await mkdir(path.dirname(data), { recursive: true })
        await writeFile(tmpData, body)
        await writeFile(tmpMeta, JSON.stringify({ contentType, sha256: sha256(body) }))
        await rename(tmpData, data)
        await rename(tmpMeta, meta)
      } catch (err) {
        await Promise.all([rm(tmpData, { force: true }), rm(tmpMeta, { force: true })]).catch(() => undefined)
        const code = (err as { code?: unknown } | null)?.code
        throw new LocalBlobWriteError(typeof code === 'string' ? code : 'UNKNOWN')
      }
      return { url: `local:${key}` }
    },
    async get(url) {
      if (typeof url !== 'string' || !url.startsWith('local:')) return null
      let key: string
      try { key = toKey(url.slice('local:'.length)) } catch { return null }
      try {
        const { data, meta } = locate(key)
        const bytes = new Uint8Array(await readFile(data))
        const m = JSON.parse(await readFile(meta, 'utf8')) as { contentType?: unknown; sha256?: unknown }
        if (m.sha256 !== sha256(bytes)) return null // torn or foreign pair
        const contentType = typeof m.contentType === 'string' && m.contentType ? m.contentType : 'application/octet-stream'
        return { bytes, contentType }
      } catch {
        return null
      }
    },
  }
}
