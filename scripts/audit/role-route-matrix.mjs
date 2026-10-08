#!/usr/bin/env node
// Role x route matrix over HTTP against a running app (next dev or next start).
//
// For every seeded staff role it signs in through POST /api/login, then
//  1. requests every page route under src/app (dynamic segments filled with
//     real ids from the database) and checks it against the expected gate:
//     the PAGE_GATES table in tests/pages/page-gates-harness.ts (the same
//     table the unit suites pin every page gate with);
//  2. crawls every internal link on every page the role reached (nav,
//     dashboard tiles, worklist rows; one representative per link shape)
//     and flags links the role cannot open (dead links) or that fail;
//  3. sweeps every GET API route for 5xx.
// It then signs in as a patient-portal patient and does the same for the
// portal pages (own documents allowed, another patient's documents refused).
// Each request is matched to the server log lines it produced, so server
// errors that still render a page (errors caught by an error boundary,
// failed queries logged by a route) are reported too.
//
// Usage (app already running, migrated and seeded):
//   DATABASE_URL=... SEED_DEMO_PASSWORD=... BASE_URL=http://localhost:3517 \
//   SERVER_LOG=/path/to/next-dev.log node scripts/audit/role-route-matrix.mjs [--json out.json] [--roles admin,crc]
// Exit code 1 when any check fails.
//
// Requests run one at a time so each server-log line belongs to exactly one request.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PASSWORD = process.env.SEED_DEMO_PASSWORD
const DOMAIN = process.env.SEED_EMAIL_DOMAIN ?? 'example.test'
const SERVER_LOG = process.env.SERVER_LOG ?? null
const TIMEOUT_MS = Number(process.env.MATRIX_TIMEOUT_MS ?? 60000)
const args = process.argv.slice(2)
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
const onlyRoles = args.includes('--roles') ? args[args.indexOf('--roles') + 1].split(',') : null

if (!PASSWORD) { console.error('SEED_DEMO_PASSWORD is required'); process.exit(2) }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2) }

// Seeded staff accounts (src/db/seed-india-data.ts DEMO_USERS); one per role.
const STAFF = [
  ['admin', 'admin'], ['crc', 'crc'], ['pi', 'pi'], ['frontdesk', 'frontdesk'], ['pharmacy', 'pharmacy'],
  ['billing', 'billing'], ['labs', 'labs'], ['coder', 'coder'], ['collector', 'collector'], ['rcm', 'rcm'],
]
const ALL_ROLES = STAFF.map(([r]) => r)
const PORTAL_PATIENT = 'RD-0001'
const OTHER_PATIENT = 'RD-0004'

// ---------------------------------------------------------------------------
// Route discovery
// ---------------------------------------------------------------------------

function walk(dir, file) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p, file))
    else if (e.name === file) out.push(p)
  }
  return out
}

function routeOf(file, base) {
  const rel = path.relative(base, path.dirname(file)).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s))
  return '/' + rel.join('/')
}

const APP = path.join(ROOT, 'src/app')
const PAGE_ROUTES = walk(APP, 'page.tsx').map((f) => routeOf(f, APP)).map((r) => (r === '/' ? '/' : r.replace(/\/$/, ''))).sort()
const API_GET_ROUTES = walk(path.join(APP, 'api'), 'route.ts')
  .filter((f) => /export\s+(const\s+GET\b|async\s+function\s+GET\b|function\s+GET\b|\{[^}]*\bGET\b)/.test(fs.readFileSync(f, 'utf8')))
  .map((f) => routeOf(f, APP)).sort()

// PAGE_GATES rows: { route, allowed[] } parsed from the unit-test table.
function parsePageGates() {
  const src = fs.readFileSync(path.join(ROOT, 'tests/pages/page-gates-harness.ts'), 'utf8')
  const start = src.indexOf('export const PAGE_GATES')
  const body = src.slice(start)
  const rows = []
  const re = /route:\s*'([^']+)'[\s\S]*?allowed:\s*\[([^\]]*)\]/g
  let m
  while ((m = re.exec(body))) {
    rows.push({ route: m[1], allowed: [...m[2].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) })
  }
  return rows
}
const PAGE_GATES = parsePageGates()

const segs = (p) => p.split('/').filter(Boolean)
function routeMatches(route, p) {
  const r = segs(route); const s = segs(p)
  return r.length === s.length && r.every((seg, i) => /^\[.+\]$/.test(seg) || seg === s[i])
}
function gateFor(p) {
  return PAGE_GATES.find((g) => g.route === p) ?? PAGE_GATES.find((g) => routeMatches(g.route, p)) ?? null
}
// Routes with their own (non-staff) access model.
const PUBLIC_PREFIXES = ['/login', '/book', '/intake', '/display/queue', '/telemedicine/join', '/patient-portal']
const isPublic = (r) => PUBLIC_PREFIXES.some((p) => r === p || r.startsWith(p + '/'))

// ---------------------------------------------------------------------------
// Dynamic segment values from the database
// ---------------------------------------------------------------------------

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
async function one(q, params = []) {
  try { const r = await db.query(q, params); return r.rows[0] ? String(Object.values(r.rows[0])[0]) : null } catch { return null }
}

const PATIENT = PORTAL_PATIENT
const SQL = {
  charge: 'select id from charges order by id limit 1',
  invoiceAny: 'select id from invoices order by id limit 1',
  invoiceFinal: "select id from invoices where status='finalised' order by id limit 1",
  receipt: "select id from patient_payments where kind='receipt' order by id limit 1",
  broadcast: 'select id from broadcasts order by id limit 1',
  submission: 'select id from form_submissions order by id limit 1',
  intakeToken: 'select access_token from form_submissions where access_token is not null order by id limit 1',
  codingEncounter: 'select encounter_id from encounter_coding order by encounter_id limit 1',
  consentDoc: 'select id from consent_documents order by id limit 1',
  review: 'select id from reviews order by id limit 1',
  template: 'select id from form_templates order by id limit 1',
  folder: 'select id from form_template_folders order by id limit 1',
  discharged: "select id from admissions where status='discharged' order by id limit 1",
  admission: 'select id from admissions order by id limit 1',
  opdEncounter: "select id from encounters order by id desc limit 1",
  claim: 'select id from claims order by id limit 1',
  payer: 'select id from payers order by id limit 1',
  preauth: 'select id from preauths order by id limit 1',
  policy: 'select id from patient_policies order by id limit 1',
  staff: 'select id from staff_members order by id limit 1',
  service: 'select id from service_catalog order by id limit 1',
  tele: 'select id from telemedicine_sessions order by id limit 1',
  teleToken: 'select patient_join_token from telemedicine_sessions order by id limit 1',
  trial: 'select id from trials order by id limit 1',
  document: 'select id from documents order by id limit 1',
  labReport: 'select id from lab_reports order by id limit 1',
  share: 'select id from abdm_profile_shares order by id limit 1',
  eligibility: 'select id from nhcx_eligibility_checks order by id limit 1',
  exchange: 'select id from nhcx_exchanges order by id limit 1',
  claimDoc: 'select id from claim_documents order by id limit 1',
  preauthDoc: 'select id from preauth_documents order by id limit 1',
  submissionCopy: 'select id from claim_submissions order by id limit 1',
  admissionWithMeds: 'select admission_id from medication_administrations order by id limit 1',
  serviceWithCodes: 'select service_id from service_procedure_codes order by service_id limit 1',
  ownInvoice: "select id from invoices where patient_id=$1 and status='finalised' order by id limit 1",
  ownReceipt: "select id from patient_payments where patient_id=$1 and kind='receipt' order by id limit 1",
  ownDischarge: "select id from admissions where patient_id=$1 and status='discharged' order by id limit 1",
  ownLabReport: 'select id from lab_reports where patient_id=$1 order by id limit 1',
  prescribed: 'select id from medication_episodes where prescribed_at is not null order by id limit 1',
  claimable: "select pp.id as policy, e.id as enc from patient_policies pp join encounters e on e.patient_id = pp.patient_id where pp.status = 'active' order by e.id desc limit 1",
}
const V = {}
for (const [k, q] of Object.entries(SQL)) V[k] = await one(q, q.includes('$1') ? [PATIENT] : [])
const claimable = await db.query(SQL.claimable).then((r) => r.rows[0] ?? null).catch(() => null)
// Another patient's documents, for the portal's own-records check.
const OTHER = {
  invoice: await one("select id from invoices where patient_id<>$1 and status='finalised' order by id limit 1", [PATIENT]),
  receipt: await one("select id from patient_payments where patient_id<>$1 and kind='receipt' order by id limit 1", [PATIENT]),
  discharge: await one("select id from admissions where patient_id<>$1 and status='discharged' order by id limit 1", [PATIENT]),
  labReport: await one('select id from lab_reports where patient_id<>$1 order by id limit 1', [PATIENT]),
}

// Page route -> concrete path (null = no row to open; reported as skipped).
const PAGE_PARAMS = {
  '/billing/charges/[chargeId]': V.charge,
  '/billing/invoices/[id]': V.invoiceAny,
  '/broadcasts/[id]': V.broadcast,
  '/client-forms/[id]': V.submission,
  '/coding/encounters/[id]': V.codingEncounter,
  '/consent-documents/[id]': V.consentDoc,
  '/experience-surveys/[id]': V.review,
  '/forms/[templateId]': V.template,
  '/forms/folders/[folderId]': V.folder,
  '/intake/[token]': V.intakeToken,
  '/patients/[anonId]': PATIENT,
  '/patients/[anonId]/medical-record': PATIENT,
  '/print/discharge/[admissionId]': V.discharged,
  '/print/invoices/[id]': V.invoiceFinal,
  '/print/receipts/[id]': V.receipt,
  '/print/registration/[anonId]': PATIENT,
  '/print/token/[encounterId]': V.opdEncounter,
  '/rcm/claims/[id]': V.claim,
  '/rcm/payers/[id]': V.payer,
  '/rcm/preauths/[id]': V.preauth,
  '/staff/[id]': V.staff,
  '/tariffs/services/[id]': V.service,
  '/telemedicine/[sessionId]': V.tele,
  '/telemedicine/join/[token]': V.teleToken,
  '/trials/[trialId]': V.trial,
  '/patient-portal/documents/discharge/[admissionId]': V.ownDischarge,
  '/patient-portal/documents/invoices/[id]': V.ownInvoice,
  '/patient-portal/documents/receipts/[id]': V.ownReceipt,
}

// Pages that need a query string to show anything (a bare URL is a deliberate 404).
const PAGE_QUERY = {
  '/prescriptions/print': V.prescribed ? `?ids=${V.prescribed}` : null,
  '/rcm/claims/new': claimable ? `?policyId=${claimable.policy}&encounterId=${claimable.enc}` : null,
}

function fill(route, value) {
  if (!route.includes('[')) return route
  if (value === null || value === undefined) return null
  return route.replace(/\[[^\]]+\]/, encodeURIComponent(value))
}

const TODAY = new Date().toISOString().slice(0, 10)
const MONTH_AGO = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)
const REPORT_KEYS = ['opd', 'ipd', 'bed-occupancy', 'discharges', 'department-revenue', 'collections', 'tariff', 'lab-tat', 'pharmacy']

// API GET route -> concrete paths (several for [report]).
function apiPaths(route) {
  const by = {
    '/api/abdm/shares/[id]': [fill(route, V.share)],
    '/api/broadcasts/[id]': [fill(route, V.broadcast)],
    '/api/charges/[id]': [fill(route, V.charge)],
    '/api/coding/services/[serviceId]/procedure-codes': [fill(route, V.serviceWithCodes ?? V.service)],
    '/api/consent-documents/[id]': [fill(route, V.consentDoc)],
    '/api/documents/[id]/download': [fill(route, V.document)],
    '/api/form-submissions/[id]': [fill(route, V.submission)],
    '/api/form-templates/[id]': [fill(route, V.template)],
    '/api/form-templates/[id]/consents': [fill(route, V.template)],
    '/api/inpatient/admissions/[id]/medications': [fill(route, V.admissionWithMeds ?? V.admission)],
    '/api/intake/[token]': [fill(route, V.intakeToken)],
    '/api/lab-reports/[id]/download': [fill(route, V.labReport)],
    '/api/labs/patients/[patientId]': [fill(route, PATIENT)],
    '/api/messages/[patientId]': [fill(route, PATIENT)],
    '/api/nhcx/eligibility/[id]': [fill(route, V.eligibility)],
    '/api/patient-portal/lab-reports/[id]/download': [fill(route, V.ownLabReport)],
    '/api/pharmacy/patients/[patientId]': [fill(route, PATIENT)],
    '/api/rcm/claim-documents/[id]': [fill(route, V.claimDoc)],
    '/api/rcm/claims/[id]/preview': [fill(route, V.claim)],
    '/api/rcm/nhcx/exchanges/[id]/payload': [fill(route, V.exchange)],
    '/api/rcm/patients/[anonId]/approved-preauths': [fill(route, PATIENT)],
    '/api/rcm/policies/[id]/card/[side]': [V.policy ? route.replace('[id]', V.policy).replace('[side]', 'front') : null],
    '/api/rcm/preauth-documents/[id]': [fill(route, V.preauthDoc)],
    '/api/rcm/submissions/[id]/copy/[copy]': [V.submissionCopy ? route.replace('[id]', V.submissionCopy).replace('[copy]', 'hospital') : null],
    '/api/rcm/submissions/[id]/verify': [fill(route, V.submissionCopy)],
    '/api/reports/[report]/csv': REPORT_KEYS.map((k) => `/api/reports/${k}/csv?from=${MONTH_AGO}&to=${TODAY}`),
    '/api/reviews/[id]': [fill(route, V.review)],
    '/api/staff/[id]': [fill(route, V.staff)],
    '/api/tariff/services/[id]/price-sheet': [fill(route, V.service)],
    '/api/telemedicine/[sessionId]/signal': [fill(route, V.tele)],
    '/api/telemedicine/join/[token]/signal': [fill(route, V.teleToken)],
    '/api/trials/[trialId]/adverse-events': [fill(route, V.trial)],
    '/api/trials/[trialId]/drug-accountability': [fill(route, V.trial)],
    '/api/trials/[trialId]/regulatory-documents': [fill(route, V.trial)],
    '/api/patients/[anonId]/insurance-card/[side]': [route.replace('[anonId]', PATIENT).replace('[side]', 'front')],
    '/api/nhcx/callback/[...action]': ['/api/nhcx/callback/coverageeligibility/on_check'],
    '/api/tariff/resolve': [`/api/tariff/resolve?serviceId=${V.service}&date=${TODAY}`],
    '/api/home-collections/availability': [`/api/home-collections/availability?pin=560001&date=${TODAY}`],
    '/api/search': ['/api/search?q=an'],
    '/api/patients/lookup': ['/api/patients/lookup?q=an'],
    '/api/coding/codes': ['/api/coding/codes?q=fever'],
    '/api/tariff/services': ['/api/tariff/services?q=con'],
    '/api/front-desk/patient-lookup': ['/api/front-desk/patient-lookup?q=an'],
  }
  if (by[route]) return by[route]
  if (route.includes('[anonId]')) return [route.replace('[anonId]', PATIENT)]
  if (route.includes('[')) return [null]
  return [route]
}

// Routes whose GET is a long poll or a deliberately slow stream: skip, not a defect.
const API_SKIP = new Set(['/api/cron/nhcx-sweep'])

// ---------------------------------------------------------------------------
// HTTP + server log
// ---------------------------------------------------------------------------

let logOffset = SERVER_LOG && fs.existsSync(SERVER_LOG) ? fs.statSync(SERVER_LOG).size : 0
function newLogErrors() {
  if (!SERVER_LOG || !fs.existsSync(SERVER_LOG)) return []
  const size = fs.statSync(SERVER_LOG).size
  if (size <= logOffset) return []
  const fd = fs.openSync(SERVER_LOG, 'r')
  const buf = Buffer.alloc(size - logOffset)
  fs.readSync(fd, buf, 0, buf.length, logOffset)
  fs.closeSync(fd)
  logOffset = size
  // eslint-disable-next-line no-control-regex
  const lines = buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  return lines.filter((l) => /⨯|\bError\b|Unhandled|TypeError|ReferenceError|hydrat|Warning:/i.test(l)
    && !/^\s*(GET|POST|PUT|PATCH|DELETE) \//.test(l)
    && !/Fast Refresh|Compiled|Compiling/.test(l)).map((l) => l.trim()).filter(Boolean).slice(0, 8)
}

// Log lines that come from a backing service this local run deliberately lacks (no Vercel Blob
// token): reported separately, not as defects.
const ENV_LOG = /\[blob-store\]/
async function settleLog() { await new Promise((r) => setTimeout(r, 40)) }

class Jar {
  constructor() { this.c = new Map() }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ') }
  take(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(';'); const i = kv.indexOf('=')
      const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim()
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(sc) || v === '') this.c.delete(k); else this.c.set(k, v)
    }
  }
}

async function request(jar, p, init = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  const started = Date.now()
  try {
    const res = await fetch(BASE + p, { ...init, redirect: 'manual', signal: ctl.signal, headers: { ...(init.headers ?? {}), cookie: jar.header() } })
    jar.take(res)
    const ct = res.headers.get('content-type') ?? ''
    const body = ct.includes('text') || ct.includes('json') ? await res.text() : (await res.arrayBuffer(), '')
    await settleLog()
    return { status: res.status, location: res.headers.get('location'), body, ct, ms: Date.now() - started, log: newLogErrors() }
  } catch (e) {
    await settleLog()
    return { status: 0, location: null, body: '', ct: '', ms: Date.now() - started, error: e.name === 'AbortError' ? 'timeout' : String(e), log: newLogErrors() }
  } finally { clearTimeout(t) }
}

// Outcome of a page response, reading Next's in-stream redirect/notFound/error markers.
function classify(r) {
  if (r.status === 0) return { kind: 'ERROR', detail: r.error }
  if (r.status >= 500) return { kind: 'ERROR', detail: `HTTP ${r.status}` }
  if (r.status >= 300 && r.status < 400) return { kind: 'REDIRECT', to: r.location ? new URL(r.location, BASE).pathname : null }
  if (r.status === 401 || r.status === 403) return { kind: 'FORBIDDEN' }
  if (r.status === 404) return { kind: 'NOTFOUND' }
  const redirect = r.body.match(/NEXT_REDIRECT;[a-z]+;([^;]+);/)
  if (redirect) return { kind: 'REDIRECT', to: redirect[1] }
  if (/NEXT_HTTP_ERROR_FALLBACK;404/.test(r.body)) return { kind: 'NOTFOUND' }
  if (/NEXT_HTTP_ERROR_FALLBACK;403/.test(r.body)) return { kind: 'FORBIDDEN' }
  const dgst = r.body.match(/data-dgst="([^"]+)"/)
  if (dgst && !dgst[1].startsWith('NEXT_')) return { kind: 'ERROR', detail: `error boundary (digest ${dgst[1]})` }
  if (/Something went wrong|This page could not load/i.test(r.body) && /digest/i.test(r.body)) return { kind: 'ERROR', detail: 'error boundary' }
  return { kind: 'OK' }
}

function links(html) {
  const out = new Set()
  for (const m of html.matchAll(/<a\b[^>]*\shref="(\/[^"#]*)"/g)) {
    const h = m[1].replace(/&amp;/g, '&')
    if (h.startsWith('/_next') || h.startsWith('/api/') || /\.(png|svg|ico|jpg|css|js)$/.test(h)) continue
    out.add(h)
  }
  return [...out]
}
// One representative per link shape (ids collapsed, query keys only).
function shape(href) {
  const [p, q = ''] = href.split('?')
  const s = p.split('/').map((x) => (/^\d+$|^RD-\d+$|^[A-Z]{2,}-?\d|^[0-9a-f-]{16,}$/i.test(x) ? ':id' : x)).join('/')
  const keys = q ? [...new URLSearchParams(q).keys()].sort().join('&') : ''
  return keys ? `${s}?${keys}` : s
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const results = { base: BASE, startedAt: new Date().toISOString(), roles: {}, portal: null, failures: [], skipped: [] }
const fail = (role, kind, target, detail) => results.failures.push({ role, kind, target, detail })

async function staffLogin(role, local) {
  const jar = new Jar()
  const r = await request(jar, '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${local}@${DOMAIN}`, password: PASSWORD }) })
  if (r.status !== 200 || !/"ok":true/.test(r.body)) throw new Error(`login ${role}: HTTP ${r.status} ${r.body.slice(0, 200)}`)
  return jar
}

const ROLE_HOME = { admin: '/', crc: '/', frontdesk: '/', pi: '/doctor', pharmacy: '/pharmacy', billing: '/billing', labs: '/labs', collector: '/collections', coder: '/coding', rcm: '/rcm' }
const DENY_TARGETS = (role) => new Set(['/', '/login', ROLE_HOME[role]])

async function runRole(role, local) {
  const jar = await staffLogin(role, local)
  const rr = { pages: [], links: [], apis: [] }
  results.roles[role] = rr
  const reached = []

  for (const route of PAGE_ROUTES) {
    if (isPublic(route)) continue
    let p = fill(route, PAGE_PARAMS[route])
    if (route in PAGE_QUERY) p = PAGE_QUERY[route] === null ? null : p + PAGE_QUERY[route]
    if (p === null) { results.skipped.push({ role, target: route, reason: 'no row to open in the database' }); continue }
    const r = await request(jar, p)
    const c = classify(r)
    const gate = route === '/' ? { allowed: ALL_ROLES } : gateFor(route)
    const expected = gate ? (gate.allowed.includes(role) ? 'allow' : 'deny') : 'any'
    let verdict = 'pass'
    if (c.kind === 'ERROR') verdict = 'fail'
    else if (c.kind === 'REDIRECT' && c.to === '/login') verdict = 'fail'
    else if (expected === 'allow' && c.kind !== 'OK') {
      // '/' sends some roles to their own home; anything else is an allowed role turned away.
      verdict = route === '/' && c.kind === 'REDIRECT' && c.to === ROLE_HOME[role] ? 'pass' : 'fail'
    } else if (expected === 'deny' && c.kind === 'OK') verdict = 'fail'
    if (r.log.length && verdict === 'pass') verdict = 'log'
    rr.pages.push({ route, path: p, status: r.status, outcome: c.kind, to: c.to, expected, verdict, ms: r.ms, log: r.log })
    if (verdict === 'fail') fail(role, 'page', p, `${c.kind}${c.to ? ` -> ${c.to}` : ''}${c.detail ? ` (${c.detail})` : ''}; expected ${expected}${r.log.length ? `; log: ${r.log[0]}` : ''}`)
    if (verdict === 'log') fail(role, 'server-log', p, r.log[0])
    if (c.kind === 'OK' && r.ct.includes('html')) reached.push({ path: p, html: r.body })
  }

  // Link crawl from every page the role reached.
  const seen = new Set()
  for (const { path: from, html } of reached) {
    for (const href of links(html)) {
      const s = shape(href)
      if (seen.has(s)) continue
      seen.add(s)
      if (href.startsWith('/login') || href.startsWith('/patient-portal') || href.startsWith('/book') || href.startsWith('/intake') || href.startsWith('/display')) continue
      const r = await request(jar, href)
      const c = classify(r)
      let verdict = 'pass'
      if (c.kind === 'ERROR') verdict = 'fail'
      else if (c.kind === 'FORBIDDEN' || c.kind === 'NOTFOUND') verdict = 'dead'
      else if (c.kind === 'REDIRECT' && DENY_TARGETS(role).has(c.to) && href.split('?')[0] !== '/') verdict = 'dead'
      if (r.log.length && verdict === 'pass') verdict = 'log'
      rr.links.push({ from, href, status: r.status, outcome: c.kind, to: c.to, verdict, log: r.log })
      if (verdict === 'fail') fail(role, 'link', href, `from ${from}: ${c.kind}${c.detail ? ` (${c.detail})` : ''}${r.log.length ? `; log: ${r.log[0]}` : ''}`)
      if (verdict === 'dead') fail(role, 'dead-link', href, `from ${from}: ${c.kind}${c.to ? ` -> ${c.to}` : ''}`)
      if (verdict === 'log') fail(role, 'server-log', href, r.log[0])
    }
  }

  // GET API sweep.
  for (const route of API_GET_ROUTES) {
    if (API_SKIP.has(route) || route.startsWith('/api/patient-portal')) continue
    for (const p of apiPaths(route)) {
      if (p === null) { results.skipped.push({ role, target: route, reason: 'no row to request' }); continue }
      let r = await request(jar, p)
      if (r.status === 0) r = await request(jar, p) // a first-compile stall, once
      const envOnly = r.log.length > 0 && r.log.every((l) => ENV_LOG.test(l))
      // 503 = an integration this run has not configured (ABDM, Google SSO): fail-closed by design.
      const verdict = r.status === 503 ? 'unconfigured' : r.status === 0 || r.status >= 500 ? 'fail' : envOnly ? 'env' : r.log.length ? 'log' : 'pass'
      if (verdict === 'unconfigured' || verdict === 'env') results.skipped.push({ role, target: p, reason: verdict === 'env' ? `local env: ${r.log[0]}` : 'HTTP 503 (integration not configured)' })
      rr.apis.push({ route, path: p, status: r.status, verdict, ms: r.ms, log: r.log })
      if (verdict === 'fail') fail(role, 'api', p, `HTTP ${r.status}${r.error ? ` ${r.error}` : ''}${r.log.length ? `; log: ${r.log[0]}` : ''}`)
      if (verdict === 'log') fail(role, 'server-log', p, r.log[0])
    }
  }
}

async function runPortal() {
  const jar = new Jar()
  const out = { pages: [], apis: [], crossPatient: [] }
  results.portal = out
  const login = await request(jar, '/api/patient-portal/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ patientId: PORTAL_PATIENT, password: PASSWORD }) })
  if (login.status !== 200) { fail('portal', 'login', '/api/patient-portal/login', `HTTP ${login.status} ${login.body.slice(0, 200)}`); return }
  const consent = await request(jar, '/api/patient-portal/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acceptedNpp: true, acceptedTos: true }) })
  if (consent.status !== 200) fail('portal', 'consent', '/api/patient-portal/consent', `HTTP ${consent.status}`)

  for (const route of PAGE_ROUTES.filter((r) => r.startsWith('/patient-portal') && !r.startsWith('/patient-portal/login'))) {
    const p = fill(route, PAGE_PARAMS[route])
    if (p === null) { results.skipped.push({ role: 'portal', target: route, reason: 'patient has no such record' }); continue }
    const r = await request(jar, p)
    const c = classify(r)
    const verdict = c.kind === 'OK' ? (r.log.length ? 'log' : 'pass') : 'fail'
    out.pages.push({ route, path: p, status: r.status, outcome: c.kind, to: c.to, verdict, log: r.log })
    if (verdict === 'fail') fail('portal', 'page', p, `${c.kind}${c.to ? ` -> ${c.to}` : ''}${c.detail ? ` (${c.detail})` : ''}${r.log.length ? `; log: ${r.log[0]}` : ''}`)
    if (verdict === 'log') fail('portal', 'server-log', p, r.log[0])
  }
  // Another patient's documents must never open.
  const cross = [
    ['/patient-portal/documents/invoices/[id]', OTHER.invoice], ['/patient-portal/documents/receipts/[id]', OTHER.receipt],
    ['/patient-portal/documents/discharge/[admissionId]', OTHER.discharge], ['/api/patient-portal/lab-reports/[id]/download', OTHER.labReport],
  ]
  for (const [route, id] of cross) {
    const p = fill(route, id)
    if (p === null) continue
    const r = await request(jar, p)
    const c = route.startsWith('/api') ? { kind: r.status >= 500 ? 'ERROR' : r.status >= 400 ? 'FORBIDDEN' : 'OK' } : classify(r)
    const verdict = c.kind === 'OK' ? 'fail' : c.kind === 'ERROR' ? 'fail' : 'pass'
    out.crossPatient.push({ route, path: p, status: r.status, outcome: c.kind, verdict })
    if (verdict === 'fail') fail('portal', 'cross-patient', p, `${c.kind} (another patient's record)`)
  }
  for (const route of API_GET_ROUTES.filter((r) => r.startsWith('/api/patient-portal'))) {
    for (const p of apiPaths(route)) {
      if (p === null) continue
      const r = await request(jar, p)
      const verdict = r.status === 0 || r.status >= 500 ? 'fail' : r.log.length ? 'log' : 'pass'
      out.apis.push({ route, path: p, status: r.status, verdict, log: r.log })
      if (verdict === 'fail') fail('portal', 'api', p, `HTTP ${r.status}`)
      if (verdict === 'log') fail('portal', 'server-log', p, r.log[0])
    }
  }
  // Unauthenticated public pages.
  const anon = new Jar()
  for (const p of ['/login', '/patient-portal/login', '/book', '/display/queue', ...STAFF.map(([, l]) => `/login/${l}`).filter((p) => PAGE_ROUTES.includes(p))]) {
    const r = await request(anon, p)
    const c = classify(r)
    if (c.kind !== 'OK') fail('anonymous', 'page', p, `${c.kind}${c.to ? ` -> ${c.to}` : ''}`)
  }
}

for (const [role, local] of STAFF) {
  if (onlyRoles && !onlyRoles.includes(role)) continue
  const t = Date.now()
  try { await runRole(role, local) } catch (e) { fail(role, 'login', '/api/login', String(e.message ?? e)) }
  const rr = results.roles[role]
  if (rr) console.log(`${role.padEnd(10)} pages ${rr.pages.length} (fail ${rr.pages.filter((x) => x.verdict !== 'pass').length})  links ${rr.links.length} (bad ${rr.links.filter((x) => x.verdict !== 'pass').length})  apis ${rr.apis.length} (bad ${rr.apis.filter((x) => x.verdict !== 'pass').length})  ${Math.round((Date.now() - t) / 1000)}s`)
}
if (!onlyRoles || onlyRoles.includes('portal')) {
  await runPortal()
  const p = results.portal
  if (p) console.log(`portal     pages ${p.pages.length} (bad ${p.pages.filter((x) => x.verdict !== 'pass').length})  cross-patient ${p.crossPatient.length} (bad ${p.crossPatient.filter((x) => x.verdict !== 'pass').length})  apis ${p.apis.length}`)
}
await db.end()

results.finishedAt = new Date().toISOString()
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2))
console.log(`\n${results.failures.length} failure(s), ${results.skipped.length} skipped`)
for (const f of results.failures) console.log(`  [${f.role}] ${f.kind} ${f.target} :: ${f.detail}`)
process.exit(results.failures.length ? 1 : 0)
