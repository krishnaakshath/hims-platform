// CLI importer flow (SP6 Task 5): argument parsing, dry run, CLI-attributed commit. Pure: the
// commit and file reader are injected fakes, so no database is touched.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseImportArgs, runCodeImportCli } from '@/lib/coding/import-cli'
import { CodeSystemVersionExistsError } from '@/lib/queries/code-systems'

const SAMPLE = readFileSync('scripts/code-systems/samples/SAMPLE-icd10.csv', 'utf8')
const BASE = ['--file', 'f.csv', '--kind', 'icd10', '--version', 'SAMPLE-ICD10-0', '--name', 'S', '--by', 'Me']

describe('parseImportArgs', () => {
  it('parses every flag', () => {
    const r = parseImportArgs([...BASE, '--licence', 'L-1', '--make-current', '--dry-run'])
    expect(r).toEqual({ ok: true, args: { file: 'f.csv', kind: 'icd10', version: 'SAMPLE-ICD10-0', name: 'S', licence: 'L-1', by: 'Me', makeCurrent: true, dryRun: true } })
  })
  it('defaults licence to null and both switches to false', () => {
    const r = parseImportArgs(BASE)
    expect(r.ok && r.args).toMatchObject({ licence: null, makeCurrent: false, dryRun: false })
  })
  it('rejects an unknown kind, an unknown flag, a missing value and a missing required flag', () => {
    expect(parseImportArgs(BASE.map((a) => (a === 'icd10' ? 'icd11' : a))).ok).toBe(false)
    expect(parseImportArgs([...BASE, '--force']).ok).toBe(false)
    expect(parseImportArgs([...BASE, '--licence']).ok).toBe(false)
    expect(parseImportArgs(BASE.slice(0, -2)).ok).toBe(false)
  })
})

describe('runCodeImportCli', () => {
  it('prints usage without required flags', async () => {
    const lines: string[] = []
    expect(await runCodeImportCli([], { readFile: vi.fn(), commit: vi.fn(), log: (l) => lines.push(l) })).toBe(2)
    expect(lines.join('\n')).toMatch(/--kind/)
  })

  it('dry-run validates and never commits', async () => {
    const commit = vi.fn()
    const lines: string[] = []
    const code = await runCodeImportCli([...BASE, '--dry-run'], { readFile: async () => SAMPLE, commit, log: (l) => lines.push(l) })
    expect(code).toBe(0)
    expect(commit).not.toHaveBeenCalled()
    expect(lines.join('\n')).toMatch(/0 issues/)
  })

  it('commits with a CLI-attributed admin session', async () => {
    const commit = vi.fn(async () => ({ codeSystemId: 7, codeCount: 6, isCurrent: true }))
    const code = await runCodeImportCli([...BASE, '--make-current'], { readFile: async () => SAMPLE, commit, log: () => {} })
    expect(code).toBe(0)
    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'icd10', version: 'SAMPLE-ICD10-0', isSample: true, makeCurrent: true, sourceFileName: 'f.csv', sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      expect.any(Array),
      { role: 'admin', name: 'CLI: Me', userId: null },
    )
  })

  it('prints line-numbered issues, never the file contents, and exits 1', async () => {
    const commit = vi.fn()
    const lines: string[] = []
    const bad = SAMPLE.replace('U8Z.1,SAMPLE fictional condition A1', 'bad!,SECRET-CELL-TEXT')
    const code = await runCodeImportCli(BASE, { readFile: async () => bad, commit, log: (l) => lines.push(l) })
    expect(code).toBe(1)
    expect(commit).not.toHaveBeenCalled()
    const out = lines.join('\n')
    expect(out).toMatch(/line 4 \[code\]: /)
    expect(out).not.toContain('SECRET-CELL-TEXT')
  })

  it('caps printed issues at 50', async () => {
    const lines: string[] = []
    const body = Array.from({ length: 80 }, () => 'bad!,SAMPLE x,,yes,yes,,,,,,').join('\n')
    const csv = `${SAMPLE.split('\n')[0]}\n${body}\n`
    expect(await runCodeImportCli(BASE, { readFile: async () => csv, commit: vi.fn(), log: (l) => lines.push(l) })).toBe(1)
    expect(lines.filter((l) => l.startsWith('line ')).length).toBe(50)
  })

  it('reports a duplicate version without a stack and exits 1', async () => {
    const lines: string[] = []
    const commit = vi.fn(async () => { throw new CodeSystemVersionExistsError() })
    expect(await runCodeImportCli(BASE, { readFile: async () => SAMPLE, commit, log: (l) => lines.push(l) })).toBe(1)
    expect(lines.join('\n')).toMatch(/already loaded/)
  })

  it('exits 1 when the file cannot be read', async () => {
    const readFile = vi.fn(async () => { throw new Error('ENOENT') })
    expect(await runCodeImportCli(BASE, { readFile, commit: vi.fn(), log: () => {} })).toBe(1)
  })
})
