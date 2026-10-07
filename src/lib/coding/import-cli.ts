// `npm run codes:import` flow (SP6, ruling 9): parse flags, validate the file with the shared
// validator under the CLI limits, then commit through the same query as the web importer.
// The operator already holds database credentials, so the import is audited as role admin with
// user name `CLI: <--by>`. Output is counts and line-numbered issue messages only; the file's
// contents are never printed (issue messages never echo cells).
import { basename } from 'node:path'
import { CODE_SYSTEM_KINDS, type CodeSystemKind } from '@/lib/coding/code-systems'
import { CLI_IMPORT_LIMITS, validateCodeSystemImport } from '@/lib/coding/import'
import { pgConstraint, pgErrorCode } from '@/lib/db-errors'
import {
  CodeSystemVersionExistsError, SampleOverLicensedError, sha256Hex, type commitCodeSystemImport,
} from '@/lib/queries/code-systems'

export interface ImportCliArgs {
  file: string
  kind: CodeSystemKind
  version: string
  name: string
  licence: string | null
  by: string
  makeCurrent: boolean
  dryRun: boolean
}

const MAX_PRINTED_ISSUES = 50

export const IMPORT_USAGE = [
  'Usage: npm run codes:import -- --file <path.csv> --kind <kind> --version <version> --name <name>',
  '         --by <your name> [--licence "<licence reference>"] [--make-current] [--dry-run]',
  `  --kind      one of ${CODE_SYSTEM_KINDS.join(', ')}`,
  '  --licence   required unless the version starts SAMPLE-',
  '  See docs/CODE-SYSTEMS.md for the CSV format and where each code set comes from.',
].join('\n')

const VALUE_FLAGS = ['file', 'kind', 'version', 'name', 'licence', 'by'] as const
type ValueFlag = (typeof VALUE_FLAGS)[number]

export function parseImportArgs(argv: string[]):
  | { ok: true; args: ImportCliArgs }
  | { ok: false; usage: string } {
  const fail = (why: string) => ({ ok: false as const, usage: `${why}\n${IMPORT_USAGE}` })
  const values: Partial<Record<ValueFlag, string>> = {}
  let makeCurrent = false
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--make-current') { makeCurrent = true; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    const m = /^--([a-z-]+)(?:=([^]*))?$/.exec(arg)
    const flag = m?.[1] as ValueFlag | undefined
    if (!m || !flag || !(VALUE_FLAGS as readonly string[]).includes(flag)) return fail(`Unknown argument: ${arg.slice(0, 40)}`)
    let value = m[2]
    if (value === undefined) {
      value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) return fail(`--${flag} needs a value`)
      i++
    }
    values[flag] = value
  }
  for (const f of ['file', 'kind', 'version', 'name', 'by'] as const) {
    if (!values[f] || values[f]!.trim() === '') return fail(`Missing --${f}`)
  }
  const kind = values.kind!.trim()
  if (!(CODE_SYSTEM_KINDS as readonly string[]).includes(kind)) return fail('Unknown --kind')
  return {
    ok: true,
    args: {
      file: values.file!,
      kind: kind as CodeSystemKind,
      version: values.version!.trim(),
      name: values.name!.trim(),
      licence: values.licence === undefined || values.licence.trim() === '' ? null : values.licence.trim(),
      by: values.by!.trim(),
      makeCurrent,
      dryRun,
    },
  }
}

export async function runCodeImportCli(
  argv: string[],
  deps: { readFile: (p: string) => Promise<string>; commit: typeof commitCodeSystemImport; log: (l: string) => void },
): Promise<number> {
  const parsed = parseImportArgs(argv)
  if (!parsed.ok) { deps.log(parsed.usage); return 2 }
  const a = parsed.args

  let text: string
  try {
    text = await deps.readFile(a.file)
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    deps.log(`Could not read the file${typeof code === 'string' ? ` (${code})` : ''}`)
    return 1
  }

  const meta = { kind: a.kind, version: a.version, name: a.name, licenceNote: a.licence }
  const result = validateCodeSystemImport(text, meta, CLI_IMPORT_LIMITS)
  deps.log(`${result.rows.length} codes read, ${result.issues.length} issues${result.isSample ? ' (SAMPLE set)' : ''}`)
  if (result.issues.length > 0) {
    for (const issue of result.issues.slice(0, MAX_PRINTED_ISSUES)) {
      deps.log(`line ${issue.line}${issue.column ? ` [${issue.column}]` : ''}: ${issue.message}`)
    }
    if (result.issues.length > MAX_PRINTED_ISSUES) deps.log(`… and ${result.issues.length - MAX_PRINTED_ISSUES} more`)
    deps.log('Nothing was loaded.')
    return 1
  }
  if (a.dryRun) {
    deps.log('Dry run: the file is valid; nothing was loaded.')
    return 0
  }

  try {
    const r = await deps.commit(
      { ...meta, sourceFileName: basename(a.file), sourceSha256: sha256Hex(text), makeCurrent: a.makeCurrent, isSample: result.isSample },
      result.rows,
      { role: 'admin', name: `CLI: ${a.by}`, userId: null },
    )
    deps.log(`Loaded ${r.codeCount} codes as code system #${r.codeSystemId}${r.isCurrent ? ' (current)' : ' (not current)'}.`)
    return 0
  } catch (err) {
    if (err instanceof CodeSystemVersionExistsError || err instanceof SampleOverLicensedError) {
      deps.log(`${err.message}. Nothing was loaded.`)
      return 1
    }
    deps.log(`Import failed (code ${pgErrorCode(err) ?? 'unknown'}, constraint ${pgConstraint(err) ?? 'none'}); nothing was loaded.`)
    return 1
  }
}
