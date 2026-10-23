// SERVER ONLY. Local-disk blob driver: dev and self-hosted fallback when no Vercel Blob store
// exists. The returned url is opaque ("local:" + a safe key), never a filesystem path. On-disk
// names are a hash of the key; the content type lives in a sidecar file.
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface BlobDriver {
  put(path: string, body: Uint8Array, contentType: string): Promise<{ url: string }>
  get(url: string): Promise<{ bytes: Uint8Array; contentType: string } | null>
}

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
      await mkdir(path.dirname(data), { recursive: true })
      await writeFile(data, body)
      await writeFile(meta, JSON.stringify({ contentType }))
      return { url: `local:${key}` }
    },
    async get(url) {
      if (typeof url !== 'string' || !url.startsWith('local:')) return null
      let key: string
      try { key = toKey(url.slice('local:'.length)) } catch { return null }
      try {
        const { data, meta } = locate(key)
        const bytes = new Uint8Array(await readFile(data))
        let contentType = 'application/octet-stream'
        try {
          const m = JSON.parse(await readFile(meta, 'utf8')) as { contentType?: unknown }
          if (typeof m.contentType === 'string' && m.contentType) contentType = m.contentType
        } catch { /* missing sidecar: default type */ }
        return { bytes, contentType }
      } catch {
        return null
      }
    },
  }
}
