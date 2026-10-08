#!/usr/bin/env node
// End-to-end walkthrough over HTTP, one role per step, against a running app
// with the India demo seed. It drives the hospital day the way staff would:
//
//   front desk registers a patient -> checks them in (OPD token)
//   doctor starts and completes the consultation, prescribes, orders a lab test
//   front desk books a home collection -> labs assigns the collector
//   collector collects -> labs receives and enters the result
//   doctor verifies -> report released
//   billing captures the consultation -> draft invoice -> finalise
//   front desk takes the receipt (cash desk)
//   RCM: insurer profile -> patient policy -> pre-auth (request, approve)
//   billing captures a payer line against the pre-auth -> payer invoice
//   RCM drafts the claim on it
//   inpatient: admit -> discharge (discharge summary)
//   admin issues portal access -> the patient sees their own bills
// and checks every print view (token, registration, prescription, invoice,
// receipt, discharge) renders as HTML without an error.
//
// Usage:
//   DATABASE_URL=... SEED_DEMO_PASSWORD=... BASE_URL=http://localhost:3517 \
//   [SERVER_LOG=...] node scripts/audit/walkthrough.mjs [--json out.json]
// Exit 1 when any step fails. Steps after a failed prerequisite are skipped.

import fs from 'node:fs'
import pg from 'pg'

const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
const PASSWORD = process.env.SEED_DEMO_PASSWORD
const DOMAIN = process.env.SEED_EMAIL_DOMAIN ?? 'example.test'
const SERVER_LOG = process.env.SERVER_LOG ?? null
const args = process.argv.slice(2)
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null
if (!PASSWORD || !process.env.DATABASE_URL) { console.error('DATABASE_URL and SEED_DEMO_PASSWORD are required'); process.exit(2) }

const db = new pg.Client({ connectionString: process.env.DATABASE_URL })
await db.connect()
const q1 = async (sql, p = []) => (await db.query(sql, p)).rows[0] ?? null

// IST calendar date (the app's business dates are IST).
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
const TODAY = istToday()
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10)

let logOffset = SERVER_LOG && fs.existsSync(SERVER_LOG) ? fs.statSync(SERVER_LOG).size : 0
function newLogErrors() {
  if (!SERVER_LOG || !fs.existsSync(SERVER_LOG)) return []
  const size = fs.statSync(SERVER_LOG).size
  if (size <= logOffset) return []
  const fd = fs.openSync(SERVER_LOG, 'r'); const buf = Buffer.alloc(size - logOffset)
  fs.readSync(fd, buf, 0, buf.length, logOffset); fs.closeSync(fd); logOffset = size
  // eslint-disable-next-line no-control-regex
  return buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    .filter((l) => /⨯|\bError\b|Unhandled|TypeError|hydrat/i.test(l) && !/^\s*(GET|POST|PUT|PATCH|DELETE) \//.test(l)).map((l) => l.trim()).slice(0, 5)
}

class Jar {
  constructor(name) { this.name = name; this.c = new Map() }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join('; ') }
  take(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(';'); const i = kv.indexOf('=')
      const k = kv.slice(0, i).trim(); const v = kv.slice(i + 1).trim()
      if (/max-age=0/i.test(sc) || v === '') this.c.delete(k); else this.c.set(k, v)
    }
  }
}

async function call(jar, method, p, body) {
  const init = { method, redirect: 'manual', headers: { cookie: jar.header() } }
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body) }
  const res = await fetch(BASE + p, init)
  jar.take(res)
  const text = await res.text()
  await new Promise((r) => setTimeout(r, 40))
  let json = null
  try { json = JSON.parse(text) } catch { /* html */ }
  return { status: res.status, json, text, ct: res.headers.get('content-type') ?? '', log: newLogErrors() }
}

const steps = []
const state = {}
async function step(name, role, needs, fn) {
  const missing = needs.filter((k) => state[k] === undefined || state[k] === null)
  if (missing.length) { steps.push({ name, role, result: 'skipped', detail: `needs ${missing.join(', ')}` }); console.log(`SKIP ${name} (needs ${missing.join(', ')})`); return }
  try {
    const detail = await fn()
    steps.push({ name, role, result: 'ok', detail: detail ?? '' })
    console.log(`ok   ${name}${detail ? ` -- ${detail}` : ''}`)
  } catch (e) {
    steps.push({ name, role, result: 'fail', detail: String(e.message ?? e) })
    console.log(`FAIL ${name} -- ${e.message ?? e}`)
  }
}
function expect(r, status, what) {
  const okStatus = Array.isArray(status) ? status.includes(r.status) : r.status === status
  if (!okStatus) throw new Error(`${what}: HTTP ${r.status} ${(r.text ?? '').slice(0, 300)}`)
  if (r.log.length) throw new Error(`${what}: server log: ${r.log[0]}`)
  return r.json
}
// A print/HTML page must render (200, HTML) with no in-stream redirect, not-found or error digest.
function expectPage(r, what, mustContain) {
  if (r.status !== 200) throw new Error(`${what}: HTTP ${r.status}`)
  if (/NEXT_REDIRECT;/.test(r.text)) throw new Error(`${what}: redirected (${(r.text.match(/NEXT_REDIRECT;[a-z]+;([^;]+);/) ?? [])[1]})`)
  if (/NEXT_HTTP_ERROR_FALLBACK;404/.test(r.text)) throw new Error(`${what}: not found`)
  const d = r.text.match(/data-dgst="([^"]+)"/)
  if (d && !d[1].startsWith('NEXT_')) throw new Error(`${what}: error boundary (digest ${d[1]})`)
  if (r.log.length) throw new Error(`${what}: server log: ${r.log[0]}`)
  if (mustContain && !r.text.includes(mustContain)) throw new Error(`${what}: page does not show ${mustContain}`)
}

const jars = {}
async function login(role) {
  if (jars[role]) return jars[role]
  const jar = new Jar(role)
  const r = await call(jar, 'POST', '/api/login', { email: `${role}@${DOMAIN}`, password: PASSWORD })
  if (r.status !== 200) throw new Error(`login ${role}: HTTP ${r.status}`)
  jars[role] = jar
  return jar
}

// ---------------------------------------------------------------------------
const ref = {
  // The pi demo login's own provider profile: a doctor moves only their own visits.
  doctor: await q1("select p.id, p.name, d.code as dept from staff_members s join users u on u.id = s.user_id join providers p on p.id = s.provider_id left join departments d on d.id = p.department_id where u.role = 'pi' order by p.id limit 1"),
  cbc: await q1("select id from lab_tests where code = 'CBC-DIFF'"),
  window: await q1('select id from home_collection_windows where is_active order by sort_order, id limit 1'),
  pin: await q1('select pin_code from lab_service_area_pins where is_active order by id limit 1'),
  consult: null, // the doctor's department consultation, resolved below
  echo: await q1("select id from service_catalog where code = 'LAB_CBC'"),
  collector: await q1("select id from users where role = 'collector' order by id limit 1"),
  insurer: await q1("select id, name from payers where name like 'Niva Bupa%'"),
  ward: await q1("select r.id from rooms r where r.status = 'available' order by r.id limit 1"),
}
ref.consult = await q1(`select id from service_catalog where code = $1`, [`CONS_${{ GEN_MED: 'GENMED', GEN_SURG: 'SURG' }[ref.doctor?.dept] ?? ref.doctor?.dept}`])
const suffix = Date.now().toString(36).slice(-5).toUpperCase()

await step('front desk registers a new patient', 'frontdesk', [], async () => {
  const fd = await login('frontdesk')
  const r = await call(fd, 'POST', '/api/patients', {
    name: `Audit Walkthrough ${suffix}`, dob: '1985-04-12', gender: 'female', phone: '9876543210', email: `audit.${suffix.toLowerCase()}@example.test`,
    addressLine1: '12 MG Road', city: 'Bengaluru', district: 'Bengaluru Urban', stateCode: 'IN-KA', pinCode: ref.pin?.pin_code ?? '560001',
    aadhaar: { status: 'declined', reason: 'patient_declined' }, abha: { status: 'unavailable', reason: 'patient_declined' },
    primaryPayerId: ref.insurer?.id, primaryMemberId: `NB-${suffix}`, primarySubscriberRelationship: 'self',
  })
  const j = expect(r, 201, 'register')
  state.patientId = j.id; state.uhid = j.uhid
  return `${j.id} UHID ${j.uhid}`
})

await step('registration slip prints', 'frontdesk', ['patientId'], async () => {
  expectPage(await call(await login('frontdesk'), 'GET', `/print/registration/${state.patientId}`), 'registration print', state.uhid)
})

await step('front desk checks the patient in (OPD)', 'frontdesk', ['patientId'], async () => {
  const r = await call(await login('frontdesk'), 'POST', '/api/front-desk/check-in', { patientId: state.patientId, providerId: ref.doctor.id, visitType: 'outpatient', urgency: 'routine', reason: 'Fever and body ache for three days' })
  const j = expect(r, 201, 'check-in')
  state.encounterId = j.encounterId; state.token = j.opdToken
  return `encounter ${j.encounterId}, token ${j.opdToken}`
})

await step('OPD token prints', 'frontdesk', ['encounterId'], async () => {
  expectPage(await call(await login('frontdesk'), 'GET', `/print/token/${state.encounterId}`), 'token print')
})

await step('doctor starts the consultation', 'pi', ['encounterId'], async () => {
  expect(await call(await login('pi'), 'POST', `/api/encounters/${state.encounterId}/status`, { to: 'in_consultation' }), 200, 'start consultation')
})

await step('doctor opens the chart', 'pi', ['patientId'], async () => {
  expectPage(await call(await login('pi'), 'GET', `/patients/${state.patientId}`), 'chart', state.uhid)
})

await step('doctor prescribes', 'pi', ['patientId'], async () => {
  const r = await call(await login('pi'), 'POST', `/api/patients/${state.patientId}/prescriptions`, {
    name: 'Paracetamol 650 mg tablet', medicationClass: 'Analgesic/antipyretic', dose: '650 mg', frequencyPerDay: 3, durationDays: 3, startDate: TODAY, instructions: 'After food',
  })
  const j = expect(r, [200, 201], 'prescribe')
  state.prescriptionId = j?.id ?? j?.episode?.id ?? j?.prescription?.id ?? (await q1('select id from medication_episodes where patient_id=$1 order by id desc limit 1', [state.patientId]))?.id
  return `prescription ${state.prescriptionId}`
})

await step('prescription prints', 'pi', ['prescriptionId'], async () => {
  expectPage(await call(await login('pi'), 'GET', `/prescriptions/print?ids=${state.prescriptionId}`), 'prescription print', 'Paracetamol')
})

await step('doctor orders a CBC', 'pi', ['patientId', 'encounterId'], async () => {
  if (!ref.cbc) throw new Error('no CBC lab test in the master')
  const r = await call(await login('pi'), 'POST', `/api/patients/${state.patientId}/lab-orders`, { labTestIds: [ref.cbc.id], originatingEncounterId: state.encounterId })
  const j = expect(r, 201, 'lab order')
  state.requisitionId = j.requisitionId
  state.labOrderId = j.lines?.[0]?.orderId ?? j.lines?.[0]?.id ?? (await q1('select id from lab_orders where patient_id=$1 order by id desc limit 1', [state.patientId]))?.id
  return `requisition ${j.requisitionId}, order ${state.labOrderId}`
})

await step('doctor completes the consultation', 'pi', ['encounterId'], async () => {
  expect(await call(await login('pi'), 'POST', `/api/encounters/${state.encounterId}/status`, { to: 'completed' }), 200, 'complete consultation')
})

await step('front desk books a home collection', 'frontdesk', ['labOrderId'], async () => {
  // Tomorrow: today's windows may already have started (booking refuses those).
  const visitDate = addDays(TODAY, 1)
  state.visitDate = visitDate
  const r = await call(await login('frontdesk'), 'POST', '/api/home-collections', {
    patientId: state.patientId, labOrderIds: [state.labOrderId], visitDate, windowId: ref.window.id,
    address: { line1: '12 MG Road', city: 'Bengaluru', stateCode: 'IN-KA', pinCode: ref.pin.pin_code }, contactPhone: '9876543210',
  })
  const j = expect(r, 201, 'book home collection')
  state.visitId = j.visit?.id
  state.sampleId = Object.values(j.sampleIds ?? {})[0]
  return `visit ${state.visitId}, sample ${state.sampleId}`
})

await step('labs assigns the collector', 'labs', ['visitId'], async () => {
  expect(await call(await login('labs'), 'PUT', `/api/home-collections/${state.visitId}/collector`, { collectorUserId: ref.collector.id }), 200, 'assign collector')
})

await step('collector sees the visit on their route', 'collector', ['visitId'], async () => {
  expectPage(await call(await login('collector'), 'GET', `/collections?date=${state.visitDate}`), 'collector route')
})

await step('collector marks the sample collected', 'collector', ['visitId', 'sampleId'], async () => {
  expect(await call(await login('collector'), 'POST', `/api/home-collections/${state.visitId}/collect`, { sampleIds: [state.sampleId] }), 200, 'collect')
})

await step('labs receives the sample', 'labs', ['sampleId'], async () => {
  expect(await call(await login('labs'), 'POST', '/api/lab-orders/receive', { sampleId: state.sampleId }), 200, 'receive')
})

await step('labs enters the result', 'labs', ['labOrderId'], async () => {
  expect(await call(await login('labs'), 'POST', `/api/lab-orders/${state.labOrderId}/result`, { value: '11.2', unit: 'g/dL', referenceRange: '12.0-15.5', flag: 'abnormal' }), 200, 'result')
})

await step('doctor verifies the result', 'pi', ['labOrderId'], async () => {
  expect(await call(await login('pi'), 'POST', `/api/lab-orders/${state.labOrderId}/verify`), 200, 'verify')
})

await step('report released', 'pi', ['requisitionId'], async () => {
  const r = await call(await login('pi'), 'POST', `/api/lab-requisitions/${state.requisitionId}/report`)
  const j = expect(r, [200, 201], 'release report')
  state.labReportId = j?.reportId ?? j?.report?.id ?? (await q1('select id from lab_reports where patient_id=$1 order by id desc limit 1', [state.patientId]))?.id
  return `report ${state.labReportId}`
})

await step('billing captures the consultation', 'billing', ['encounterId'], async () => {
  const r = await call(await login('billing'), 'POST', '/api/billing/charge-lines', { context: { encounterId: state.encounterId }, serviceId: ref.consult.id, quantity: 1, serviceDate: TODAY, billTo: 'patient' })
  const j = expect(r, 201, 'capture')
  state.lineId = j.line.id
  return `line ${j.line.id}${j.violations?.length ? ` (warnings: ${j.violations.map((v) => v.code).join(',')})` : ''}`
})

await step('billing drafts the invoice', 'billing', ['lineId'], async () => {
  const j = expect(await call(await login('billing'), 'POST', '/api/billing/invoices', { lineIds: [state.lineId] }), 201, 'draft invoice')
  state.invoiceId = j.invoiceId ?? j.id ?? j.invoice?.id
  return `invoice ${state.invoiceId}`
})

await step('billing finalises the invoice', 'billing', ['invoiceId'], async () => {
  const j = expect(await call(await login('billing'), 'POST', `/api/billing/invoices/${state.invoiceId}/finalise`, {}), 200, 'finalise')
  state.invoiceNumber = j.invoiceNumber
  state.invoiceTotal = Number((await q1('select total_paise from invoices where id=$1', [state.invoiceId])).total_paise)
  return `${j.invoiceNumber}, total ${state.invoiceTotal} paise`
})

await step('invoice prints', 'billing', ['invoiceNumber'], async () => {
  expectPage(await call(await login('billing'), 'GET', `/print/invoices/${state.invoiceId}`), 'invoice print', state.invoiceNumber)
})

await step('front desk takes the payment at the cash desk', 'frontdesk', ['invoiceNumber'], async () => {
  const j = expect(await call(await login('frontdesk'), 'POST', '/api/billing/payments', { patientId: state.patientId, kind: 'receipt', invoiceId: state.invoiceId, mode: 'upi', reference: `UPI${suffix}01`, amountPaise: state.invoiceTotal }), 201, 'receipt')
  state.paymentId = j.paymentId; state.receiptNumber = j.receiptNumber
  return j.receiptNumber
})

await step('receipt prints', 'frontdesk', ['paymentId'], async () => {
  expectPage(await call(await login('frontdesk'), 'GET', `/print/receipts/${state.paymentId}`), 'receipt print', state.receiptNumber)
})

// ---- RCM -----------------------------------------------------------------------------------
await step('RCM sets up the insurer profile', 'rcm', [], async () => {
  if (!ref.insurer) throw new Error('no Niva Bupa payer in the seed')
  expect(await call(await login('rcm'), 'PUT', `/api/rcm/payers/${ref.insurer.id}`, {
    kind: 'insurer', shortName: 'Niva Bupa', defaultChannel: 'portal', empanelmentStatus: 'empanelled', preauthSlaHours: 6, claimSettlementSlaDays: 30,
    queryResponseDays: 7, submissionWindowDays: 30, requiresAbha: false, requiresPreauthForIpd: true, active: true,
  }), 200, 'payer profile')
  state.insurerReady = true
})

await step('RCM records the patient policy', 'rcm', ['patientId', 'insurerReady'], async () => {
  const j = expect(await call(await login('rcm'), 'POST', '/api/rcm/policies', {
    patientId: state.patientId, insurerPayerId: ref.insurer.id, policyNumber: `NB/${suffix}/2026`, memberId: `NB-${suffix}`, policyType: 'individual',
    holderName: `Audit Walkthrough ${suffix}`, relationship: 'self', validFrom: addDays(TODAY, -100), validTo: addDays(TODAY, 265), sumInsuredPaise: 500000_00, priority: 'primary',
  }), 201, 'policy')
  state.policyId = j.policyId ?? j.id
  return `policy ${state.policyId}`
})

await step('RCM raises an OPD pre-auth', 'rcm', ['policyId', 'encounterId'], async () => {
  const j = expect(await call(await login('rcm'), 'POST', '/api/rcm/preauths', {
    policyId: state.policyId, claimType: 'opd', encounterId: state.encounterId, plannedAdmissionDate: TODAY, expectedLengthOfStayDays: 1,
    treatingProviderId: ref.doctor.id, diagnosisCodeIds: [], procedureCodeIds: [], provisionalDiagnosisText: 'Acute febrile illness',
    estimate: [{ serviceId: ref.echo.id, quantity: 1 }],
  }), 201, 'preauth')
  state.preauthId = j.preauthId
  return `${j.preauthNumber}`
})

await step('RCM submits and records the approval', 'rcm', ['preauthId'], async () => {
  const rcm = await login('rcm')
  expect(await call(rcm, 'POST', `/api/rcm/preauths/${state.preauthId}/actions`, { action: 'request' }), 200, 'request')
  state.approvalRef = `NBAPR-${suffix}`
  expect(await call(rcm, 'POST', `/api/rcm/preauths/${state.preauthId}/actions`, { action: 'approve', approvedPaise: 350_00, approvalReference: state.approvalRef, validUntil: addDays(TODAY, 15), decidedOn: TODAY }), 200, 'approve')
  return state.approvalRef
})

await step('pre-auth detail page opens', 'rcm', ['preauthId'], async () => {
  expectPage(await call(await login('rcm'), 'GET', `/rcm/preauths/${state.preauthId}`), 'preauth detail', state.approvalRef)
})

await step('billing captures the payer line against the pre-auth', 'billing', ['approvalRef', 'encounterId'], async () => {
  const j = expect(await call(await login('billing'), 'POST', '/api/billing/charge-lines', { context: { encounterId: state.encounterId }, serviceId: ref.echo.id, quantity: 1, serviceDate: TODAY, billTo: 'payer', preAuthReference: state.approvalRef }), 201, 'payer capture')
  state.payerLineId = j.line.id
  return `line ${j.line.id}`
})

await step('billing finalises the payer invoice', 'billing', ['payerLineId'], async () => {
  const b = await login('billing')
  const d = expect(await call(b, 'POST', '/api/billing/invoices', { lineIds: [state.payerLineId] }), 201, 'draft payer invoice')
  state.payerInvoiceId = d.invoiceId ?? d.id
  const f = expect(await call(b, 'POST', `/api/billing/invoices/${state.payerInvoiceId}/finalise`, {}), 200, 'finalise payer invoice')
  return f.invoiceNumber
})

await step('RCM drafts the claim', 'rcm', ['payerInvoiceId', 'policyId', 'preauthId'], async () => {
  const j = expect(await call(await login('rcm'), 'POST', '/api/rcm/claims', { policyId: state.policyId, claimType: 'opd', encounterId: state.encounterId, preauthId: state.preauthId, invoices: [{ invoiceId: state.payerInvoiceId }] }), 201, 'claim')
  state.claimId = j.claimId ?? j.id
  return `${j.claimNumber ?? ''} (claim ${state.claimId})`
})

await step('claim workspace opens', 'rcm', ['claimId'], async () => {
  expectPage(await call(await login('rcm'), 'GET', `/rcm/claims/${state.claimId}`), 'claim workspace')
})

await step('claim preview renders', 'rcm', ['claimId'], async () => {
  const r = await call(await login('rcm'), 'GET', `/api/rcm/claims/${state.claimId}/preview`)
  if (r.status >= 500) throw new Error(`preview: HTTP ${r.status}`)
  return `HTTP ${r.status}`
})

// ---- inpatient -----------------------------------------------------------------------------
await step('front desk admits the patient', 'frontdesk', ['patientId'], async () => {
  if (!ref.ward) throw new Error('no available bed')
  const j = expect(await call(await login('frontdesk'), 'POST', '/api/front-desk/check-in', { patientId: state.patientId, providerId: ref.doctor.id, visitType: 'inpatient', urgency: 'urgent', reason: 'Observation for dehydration', roomId: ref.ward.id }), 201, 'admit')
  state.admissionId = (await q1("select id from admissions where patient_id=$1 and status='admitted' order by id desc limit 1", [state.patientId]))?.id
  return `admission ${state.admissionId} (encounter ${j.encounterId})`
})

await step('doctor discharges the patient', 'pi', ['admissionId'], async () => {
  expect(await call(await login('pi'), 'POST', `/api/inpatient/admissions/${state.admissionId}/discharge`, {
    dischargeDiagnosis: 'Acute gastroenteritis with mild dehydration', dischargeDrugs: 'ORS sachets as needed', dischargeDevices: 'None',
    dischargeDiet: 'Soft diet, plenty of fluids', dischargeSummaryNotes: 'Improved with IV fluids. Review in OPD if symptoms recur.', typedName: 'Dr. R. Kunam',
  }), 200, 'discharge')
})

await step('discharge summary prints (doctor and front desk copies)', 'pi', ['admissionId'], async () => {
  expectPage(await call(await login('pi'), 'GET', `/print/discharge/${state.admissionId}`), 'discharge print (pi)', 'Acute gastroenteritis')
  expectPage(await call(await login('frontdesk'), 'GET', `/print/discharge/${state.admissionId}`), 'discharge print (frontdesk)')
})

// ---- patient portal ------------------------------------------------------------------------
await step('admin issues portal access', 'admin', ['patientId'], async () => {
  const j = expect(await call(await login('admin'), 'POST', `/api/patients/${state.patientId}/portal-password`), 200, 'portal password')
  state.portalPassword = j.password
})

await step('patient signs in and accepts the policies', 'portal', ['portalPassword'], async () => {
  const jar = new Jar('portal'); jars.portal = jar
  expect(await call(jar, 'POST', '/api/patient-portal/login', { patientId: state.patientId, password: state.portalPassword }), 200, 'portal login')
  expect(await call(jar, 'POST', '/api/patient-portal/consent', { acceptedNpp: true, acceptedTos: true }), 200, 'consent')
  state.portalIn = true
})

await step('patient sees their own bill and receipt', 'portal', ['portalIn', 'invoiceNumber'], async () => {
  expectPage(await call(jars.portal, 'GET', '/patient-portal/bills'), 'portal bills', state.invoiceNumber)
  expectPage(await call(jars.portal, 'GET', `/patient-portal/documents/invoices/${state.invoiceId}`), 'portal invoice document', state.invoiceNumber)
  if (state.paymentId) expectPage(await call(jars.portal, 'GET', `/patient-portal/documents/receipts/${state.paymentId}`), 'portal receipt document', state.receiptNumber)
})

await step('patient sees the lab report and discharge summary lists', 'portal', ['portalIn'], async () => {
  expectPage(await call(jars.portal, 'GET', '/patient-portal/lab-reports'), 'portal lab reports')
  expectPage(await call(jars.portal, 'GET', '/patient-portal/discharge-summaries'), 'portal discharge summaries')
  if (state.admissionId) expectPage(await call(jars.portal, 'GET', `/patient-portal/documents/discharge/${state.admissionId}`), 'portal discharge document')
})

await step("patient cannot open another patient's invoice", 'portal', ['portalIn'], async () => {
  const other = await q1("select id from invoices where patient_id <> $1 and status='finalised' order by id limit 1", [state.patientId])
  const r = await call(jars.portal, 'GET', `/patient-portal/documents/invoices/${other.id}`)
  if (r.status === 200 && !/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_REDIRECT;/.test(r.text)) throw new Error('another patient\'s invoice rendered')
})

await db.end()
const failed = steps.filter((s) => s.result === 'fail')
const skipped = steps.filter((s) => s.result === 'skipped')
console.log(`\n${steps.length} steps: ${steps.length - failed.length - skipped.length} ok, ${failed.length} failed, ${skipped.length} skipped`)
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ base: BASE, state: { ...state, portalPassword: undefined }, steps }, null, 2))
process.exit(failed.length ? 1 : 0)
