// SP7 (server only): SHA-256 helpers for uploads, copies and snapshots.
import { createHash } from 'node:crypto'
import { canonicalJson } from './snapshot'

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** The fingerprint of a snapshot: SHA-256 of its canonical JSON. */
export function snapshotSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
