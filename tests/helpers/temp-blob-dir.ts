import { beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * Points the local-disk blob driver (the only file store) at a fresh temp directory for each test
 * and removes it afterwards. Returns a getter for the current directory.
 */
export function withTempBlobDir(): () => string {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'hims-blobs-'))
    vi.stubEnv('BLOB_DRIVER', 'local')
    vi.stubEnv('BLOB_LOCAL_DIR', dir)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return () => dir
}
