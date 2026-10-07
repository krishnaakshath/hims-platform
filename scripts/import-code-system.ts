// CLI entry for loading a licensed code set: `npm run codes:import -- --file … --kind … …`.
// All logic lives in src/lib/coding/import-cli.ts; see docs/CODE-SYSTEMS.md.
import { readFile, stat } from 'node:fs/promises'
import { runCodeImportCli } from '../src/lib/coding/import-cli'
import { CLI_IMPORT_LIMITS } from '../src/lib/coding/import'
import { commitCodeSystemImport } from '../src/lib/queries/code-systems'

async function readCapped(path: string): Promise<string> {
  // Refuse an oversize file before reading it into memory.
  const s = await stat(path)
  if (s.size > CLI_IMPORT_LIMITS.maxBytes) throw Object.assign(new Error('too large'), { code: 'FILE_TOO_LARGE' })
  return readFile(path, 'utf8')
}

runCodeImportCli(process.argv.slice(2), { readFile: readCapped, commit: commitCodeSystemImport, log: (l) => console.log(l) })
  .then((code) => process.exit(code))
  .catch(() => { console.error('Import failed unexpectedly; nothing was loaded.'); process.exit(1) })
