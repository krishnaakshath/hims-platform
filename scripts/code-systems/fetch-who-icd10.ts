// Fetches the official WHO ICD-10 (2019) ClaML release and converts it to the importer CSV.
//   npm run codes:fetch-who [-- --url <https who.int url>] [-- --file <local .zip or .xml>]
// Output (git-ignored, never commit it): data/code-systems/who-icd10-2019.csv. Refuses in production.
// Only https URLs on who.int hosts are accepted. Prints the SHA-256 of the fetched file.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertWhoIcd10 } from './convert-who-icd10'

export const DEFAULT_WHO_ICD10_URL = 'https://icdcdn.who.int/icd10/claml/icd102019en.xml.zip'
const OUT_DIR = join(process.cwd(), 'data', 'code-systems')

export function isOfficialWhoUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' && (u.hostname === 'who.int' || u.hostname.endsWith('.who.int'))
  } catch { return false }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run with NODE_ENV=production')
  mkdirSync(OUT_DIR, { recursive: true })
  const file = arg('--file')
  let bytes: Buffer
  let origin: string
  if (file) {
    bytes = readFileSync(file)
    origin = file
  } else {
    const url = arg('--url') ?? DEFAULT_WHO_ICD10_URL
    if (!isOfficialWhoUrl(url)) throw new Error('Only https URLs on who.int hosts are allowed')
    const res = await fetch(url, { redirect: 'error' })
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`)
    bytes = Buffer.from(await res.arrayBuffer())
    origin = url
  }
  const sha = createHash('sha256').update(bytes).digest('hex')
  const isZip = bytes.subarray(0, 2).toString('latin1') === 'PK'
  const rawPath = join(OUT_DIR, isZip ? 'who-icd10-2019.zip' : 'who-icd10-2019.xml')
  writeFileSync(rawPath, bytes)
  const xml = isZip
    ? execFileSync('unzip', ['-p', rawPath, '*.xml'], { maxBuffer: 200_000_000 }).toString('utf8')
    : bytes.toString('utf8')
  if (!/ICD-10/.test(xml.slice(0, 5000)) || !/version="2019/.test(xml.slice(0, 5000))) throw new Error('Source does not look like the WHO ICD-10 2019 ClaML file')
  const { csv, codeCount } = convertWhoIcd10(xml)
  const csvPath = join(OUT_DIR, 'who-icd10-2019.csv')
  writeFileSync(csvPath, csv)
  console.log(`source: ${origin}`)
  console.log(`sha256: ${sha}`)
  console.log(`codes:  ${codeCount}`)
  console.log(`csv:    ${csvPath}`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : 'Fetch failed'); process.exit(1) })
