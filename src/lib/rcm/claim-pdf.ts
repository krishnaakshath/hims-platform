// SERVER ONLY. SP7 (ruling 3): renders one claim snapshot as a PDF copy — the RCM copy retained by
// the hospital (ending with the snapshot hash), the insurer copy, or an unsaved draft preview.
// Pure over its input (no clock, network or filesystem): the same snapshot gives the same bytes.
// Standard fonts only; every string goes through the SP5 PDF-safe text helper, amounts print as
// "Rs. …" because the standard fonts cannot encode the rupee sign.
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { formatPaise } from '@/lib/format'
import { formatDateTimeIn, formatIsoDate } from '@/lib/india-time'
import { toPdfSafeText } from '@/lib/labs/report-data'
import { CLAIM_DOCUMENT_KIND_LABEL, PAYER_KIND_LABEL } from './constants'
import type { ClaimSnapshot } from './snapshot'

const A4: [number, number] = [595.28, 841.89]
const MARGIN = 50
const WIDTH = A4[0] - 2 * MARGIN
const TOP = A4[1] - MARGIN
const BOTTOM = 70
const BLACK = rgb(0, 0, 0)
const GREY = rgb(0.35, 0.35, 0.35)
const RULE = rgb(0.7, 0.7, 0.7)
const BODY = 9
const LINE = 12

export const COPY_BANNER = {
  rcm: 'RCM COPY - RETAINED BY HOSPITAL',
  insurer: 'INSURER COPY',
  draft: 'DRAFT - NOT SUBMITTED',
} as const

const rs = (paise: number | null) => (paise === null ? '-' : formatPaise(paise).replace('₹', 'Rs. '))
const date = (iso: string | null) => (iso ? formatIsoDate(iso) : '-')
const orDash = (s: string | null | undefined) => (s && s.trim() !== '' ? s : '-')

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = toPdfSafeText(text)
  if (safe === '') return ['']
  const out: string[] = []
  let current = ''
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= maxWidth
  for (const word of safe.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (fits(candidate)) { current = candidate; continue }
    if (current !== '') out.push(current)
    current = ''
    let piece = ''
    for (const ch of word) {
      if (fits(piece + ch)) { piece += ch; continue }
      if (piece !== '') out.push(piece)
      piece = ch
    }
    current = piece
  }
  if (current !== '') out.push(current)
  return out
}

class Writer {
  pages: PDFPage[] = []
  private page!: PDFPage
  private y = TOP
  constructor(private doc: PDFDocument, private fonts: { regular: PDFFont; bold: PDFFont }, private banner: string) { this.newPage() }

  private newPage() {
    this.page = this.doc.addPage(A4)
    this.pages.push(this.page)
    this.page.drawText(this.banner, { x: MARGIN, y: TOP, size: 12, font: this.fonts.bold, color: BLACK })
    this.page.drawLine({ start: { x: MARGIN, y: TOP - 6 }, end: { x: A4[0] - MARGIN, y: TOP - 6 }, thickness: 1, color: BLACK })
    this.y = TOP - 24
  }

  private ensure(height: number) { if (this.y - height < BOTTOM) this.newPage() }

  line(s: string, opts: { bold?: boolean; indent?: number; size?: number; color?: ReturnType<typeof rgb> } = {}) {
    const font = opts.bold ? this.fonts.bold : this.fonts.regular
    const size = opts.size ?? BODY
    const indent = opts.indent ?? 0
    for (const part of wrap(s, font, size, WIDTH - indent)) {
      this.ensure(LINE)
      if (part !== '') this.page.drawText(part, { x: MARGIN + indent, y: this.y, size, font, color: opts.color ?? BLACK })
      this.y -= LINE
    }
  }

  field(label: string, value: string) { this.line(`${label}: ${value}`, { indent: 8 }) }

  section(title: string) {
    this.ensure(LINE * 3)
    this.y -= 4
    this.page.drawLine({ start: { x: MARGIN, y: this.y + 9 }, end: { x: A4[0] - MARGIN, y: this.y + 9 }, thickness: 0.5, color: RULE })
    this.line(title, { bold: true, size: 10 })
  }

  footers(claimNumber: string, version: number) {
    const total = this.pages.length
    this.pages.forEach((p, i) => {
      const s = toPdfSafeText(`${claimNumber} v${version} - page ${i + 1} of ${total}`)
      p.drawText(s, { x: MARGIN, y: 40, size: 8, font: this.fonts.regular, color: GREY })
    })
  }
}

export async function renderClaimCopyPdf(snapshot: ClaimSnapshot, copy: 'rcm' | 'insurer' | 'draft', opts: { snapshotSha256?: string } = {}): Promise<Uint8Array> {
  if (copy === 'rcm' && !opts.snapshotSha256) throw new TypeError('The RCM copy needs the snapshot hash')
  const s = snapshot
  const doc = await PDFDocument.create()
  doc.setTitle(`${s.claim.claimNumber} v${s.claim.version} ${copy}`)
  doc.setCreationDate(new Date(s.claim.preparedAt))
  doc.setModificationDate(new Date(s.claim.preparedAt))
  const fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) }
  const w = new Writer(doc, fonts, COPY_BANNER[copy])

  w.section('Claim and hospital')
  w.field('Claim number', `${s.claim.claimNumber} (version ${s.claim.version}, ${s.claim.kind.replace('_', ' ')})`)
  w.field('Claim type', s.claim.claimType.toUpperCase())
  w.field('Prepared', formatDateTimeIn(new Date(s.claim.preparedAt)))
  w.field('Hospital', orDash(s.hospital.legalName))
  w.field('GSTIN', orDash(s.hospital.gstin))
  w.field('ROHINI ID', orDash(s.hospital.rohiniId))
  w.field('HFR ID', orDash(s.hospital.hfrId))

  w.section('Patient and policy')
  w.field('Patient', `${s.patient.name} (${orDash(s.patient.uhid)})`)
  w.field('Gender / date of birth', `${orDash(s.patient.gender)} / ${date(s.patient.dob)}`)
  if (s.patient.abhaNumber) w.field('ABHA number', s.patient.abhaNumber)
  w.field('Insurer', `${s.policy.insurer.name} (${PAYER_KIND_LABEL[s.policy.insurer.kind]})`)
  w.field('TPA', s.policy.tpa ? s.policy.tpa.name : '-')
  w.field('Policy number / member ID', `${s.policy.policyNumber} / ${s.policy.memberId}`)
  w.field('Plan', `${orDash(s.policy.planName)} (${s.policy.policyType.replace('_', ' ')})${s.policy.corporateName ? `, ${s.policy.corporateName}` : ''}`)
  w.field('Policy holder', `${s.policy.holderName} (${s.policy.relationship})`)
  w.field('Valid', `${date(s.policy.validFrom)} to ${date(s.policy.validTo)}`)
  w.field('Sum insured', rs(s.policy.sumInsuredPaise))

  w.section('Episode')
  w.field(s.episode.admissionId !== null ? 'Admission' : 'Visit', String(s.episode.admissionId ?? s.episode.encounterId ?? '-'))
  w.field('Dates', `${date(s.episode.startDate)} to ${date(s.episode.endDate)}${s.episode.lengthOfStayDays !== null ? ` (${s.episode.lengthOfStayDays} days)` : ''}`)
  w.field('Treating doctor', `${orDash(s.episode.attendingName)}${s.episode.attendingRegistration ? `, ${s.episode.attendingRegistration}` : ''}`)
  w.field('Department', orDash(s.episode.departmentName))

  w.section('Pre-authorisation')
  if (s.preauth) {
    w.field('Number / approval reference', `${s.preauth.preauthNumber} / ${orDash(s.preauth.approvalReference)}`)
    w.field('Approved / valid until', `${rs(s.preauth.approvedPaise)} / ${date(s.preauth.validUntil)}`)
  } else {
    w.line('No pre-authorisation linked', { indent: 8 })
  }

  w.section('Diagnoses')
  if (s.diagnoses.length === 0) w.line('None recorded', { indent: 8 })
  for (const d of s.diagnoses) w.line(`${d.type}: ${d.kind.toUpperCase()} ${d.code} - ${d.display}${d.version ? ` (${d.version})` : ''}`, { indent: 8 })

  w.section('Procedures')
  if (s.procedures.length === 0) w.line('None recorded', { indent: 8 })
  for (const p of s.procedures) w.line(`${p.kind.toUpperCase()} ${p.code} - ${p.display}, ${date(p.performedOn)}`, { indent: 8 })

  w.section('Discharge summary')
  if (s.dischargeSummary) {
    w.field('Diagnosis', orDash(s.dischargeSummary.diagnosis))
    w.field('Notes', orDash(s.dischargeSummary.notes))
    w.field('Medicines', orDash(s.dischargeSummary.drugs))
    w.field('Devices', orDash(s.dischargeSummary.devices))
    w.field('Diet', orDash(s.dischargeSummary.diet))
    w.field('Follow-up due', date(s.dischargeSummary.followUpDue))
  } else {
    w.line('Not applicable', { indent: 8 })
  }

  w.section('Itemised bill')
  for (const i of s.items) {
    w.line(`${i.sequence}. ${i.invoiceNumber}/${i.lineNo} ${i.itemCode} ${i.itemName}, ${date(i.serviceDate)}, HSN/SAC ${i.hsnSac}: ${i.quantity} x ${rs(i.unitPricePaise)} + tax ${rs(i.taxPaise)} = ${rs(i.totalPaise)}`, { indent: 8 })
  }
  for (const inv of s.invoices) w.field(`Invoice ${inv.number} (${date(inv.date)})`, `total ${rs(inv.totalPaise)}, claimed ${rs(inv.claimedPaise)}`)
  w.line(`Total billed ${rs(s.totals.billedPaise)}; total claimed ${rs(s.totals.claimedPaise)}`, { bold: true, indent: 8 })

  w.section('Documents')
  if (s.documents.length === 0) w.line('None', { indent: 8 })
  for (const d of s.documents) {
    w.line(`${CLAIM_DOCUMENT_KIND_LABEL[d.kind]}: ${d.title} [${d.waived ? 'waived' : d.sha256 ? d.sha256.slice(0, 12) : 'system record'}]`, { indent: 8 })
  }

  if (s.coverNote) {
    w.section('Cover note')
    w.line(s.coverNote, { indent: 8 })
  }

  if (copy === 'rcm') {
    w.section('Integrity')
    w.line(`Snapshot SHA-256: ${opts.snapshotSha256}`, { size: 8 })
  }
  w.footers(s.claim.claimNumber, s.claim.version)
  return doc.save({ useObjectStreams: false })
}

