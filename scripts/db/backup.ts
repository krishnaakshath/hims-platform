// npm run db:backup [-- --out <dir>]
//
// Logical backup of DATABASE_URL with pg_dump (custom format, compressed),
// plus a .sha256 next to it and a readability check with pg_restore --list.
// The dump holds patient data (identity numbers stay AES-encrypted, so the
// dump is useless without IDENTITY_ENCRYPTION_KEY, and vice versa): store it
// encrypted, off the laptop, never in git. Procedure and retention:
// docs/OPERATIONS.md.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { describeDatabaseUrl, isPooledNeonUrl } from '../../src/db/url'
import { INSTALL_HELP, backupFileName, findPgTool, pgEnvFromUrl } from './pg-tools'

function main(): number {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is not set.')
    return 1
  }
  if (isPooledNeonUrl(url)) {
    console.error('DATABASE_URL is the Neon pooled endpoint; pg_dump needs the direct one: DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:backup')
    return 1
  }
  const dump = findPgTool('pg_dump')
  const restore = findPgTool('pg_restore')
  if (!dump || !restore) {
    console.error(INSTALL_HELP)
    return 2
  }

  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : 'backups')
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 })
  const env = pgEnvFromUrl(url)
  const file = path.join(outDir, backupFileName(env.PGDATABASE, new Date()))

  console.log(`backing up ${describeDatabaseUrl(url)} with ${dump.version}`)
  const t0 = Date.now()
  const r = spawnSync(dump.bin, ['--format=custom', '--compress=6', '--no-owner', '--no-privileges', `--file=${file}`], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (r.status !== 0) {
    console.error(`pg_dump failed (exit ${r.status}). A server newer than the client is the usual cause: install a matching pg_dump.`)
    fs.rmSync(file, { force: true })
    return 1
  }
  fs.chmodSync(file, 0o600)

  const list = spawnSync(restore.bin, ['--list', file], { encoding: 'utf8' })
  if (list.status !== 0) {
    console.error('pg_restore could not read the dump back; do not rely on it.')
    return 1
  }
  const entries = list.stdout.split('\n').filter((l) => l && !l.startsWith(';')).length
  const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  fs.writeFileSync(`${file}.sha256`, `${hash}  ${path.basename(file)}\n`, { mode: 0o600 })
  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(1)
  console.log(`wrote ${file} (${mb} MB, ${entries} archive entries, ${Date.now() - t0} ms)`)
  console.log(`sha256 ${hash}`)
  console.log('Next: copy it (and the .sha256) to encrypted off-site storage, then run the restore drill: npm run db:restore-check -- <file>')
  return 0
}

process.exit(main())
