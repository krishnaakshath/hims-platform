// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Repo-wide guard: the product name is per-deployment config (src/lib/brand.ts),
// so the old hardcoded name must not reappear anywhere in src/ -- UI, emails,
// SMS, printouts, cookie names or comments. Only brand.ts (which documents the
// legacy cookie name, if at all) is exempt.
const SRC = join(__dirname, '..', '..', 'src')
const EXCLUDED = new Set(['lib/brand.ts'].map((p) => p.split('/').join(sep)))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

describe('no legacy product name in src/', () => {
  it('finds no "clinsync" (case-insensitive) outside the allowed files', () => {
    const offenders = walk(SRC)
      .filter((f) => !EXCLUDED.has(relative(SRC, f)))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (/clinsync/i.test(line) ? `${relative(SRC, f)}:${i + 1}` : null))
        .filter((x): x is string => x !== null))
    expect(offenders).toEqual([])
  })
})
