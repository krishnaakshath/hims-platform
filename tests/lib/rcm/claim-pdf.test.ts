import { describe, it, expect } from 'vitest'
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDocument, PDFName, PDFRawStream, type PDFPage } from 'pdf-lib'
import { renderClaimCopyPdf } from '@/lib/rcm/claim-pdf'
import { buildClaimSnapshot, type ClaimSnapshotSource } from '@/lib/rcm/snapshot'

function streamBytes(page: PDFPage): Buffer[] {
  const contents = page.node.Contents()
  const streams = contents instanceof PDFArray ? contents.asArray().map((ref) => page.doc.context.lookup(ref)) : [contents]
  return streams.map((s) => {
    if (!(s instanceof PDFRawStream)) throw new Error('unexpected content stream type')
    const raw = Buffer.from(s.getContents())
    return s.dict.get(PDFName.of('Filter')) === PDFName.of('FlateDecode') ? inflateSync(raw) : raw
  })
}
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((page) => streamBytes(page)
    .map((b) => [...b.toString('latin1').matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('\n')).join('\n')).join('\n')
}

const SRC: ClaimSnapshotSource = {
  claim: { claimNumber: 'CLM-2099-000001', claimType: 'ipd', version: 1, kind: 'initial', preparedAt: '2099-06-01T06:00:00.000Z' },
  hospital: { legalName: 'Test Hospital', gstin: null, stateCode: 'IN-KA', rohiniId: '8900080123456', hfrId: null },
  patient: { id: 'P-1', uhid: 'UH1', name: 'Asha Rao', gender: 'female', dob: '1980-01-01' }, includeAbha: false, patientAbhaNumber: null,
  policy: {
    insurer: { payerId: 1, name: 'Test Insurer', kind: 'insurer', irdaiRegistrationNo: null, nhcxParticipantCode: null }, tpa: null,
    policyNumber: 'POL/1', memberId: 'M-1', planName: null, policyType: 'individual', holderName: 'Asha', relationship: 'self', validFrom: '2026-04-01', validTo: '2027-03-31', sumInsuredPaise: null, corporateName: null,
  },
  episode: { admissionId: 3, encounterId: null, startDate: '2026-10-01', endDate: '2026-10-04', lengthOfStayDays: 3, attendingName: 'Dr X', attendingRegistration: null, departmentName: null },
  preauth: null, diagnoses: [{ kind: 'icd10', code: 'K35.8', display: 'Acute appendicitis', version: '2019', sequence: 1, type: 'primary' }], procedures: [], discharge: null,
  invoices: [{ number: 'INV/1', date: '2099-06-01', totalPaise: 3_540_000_000, claimedPaise: 3_540_000_000 }],
  items: [{ invoiceNumber: 'INV/1', lineNo: 1, itemCode: 'S1', itemName: 'Surgery', hsnSac: '9993', serviceDate: '2026-10-02', quantity: 1, unitPricePaise: 3_540_000_000, taxablePaise: 3_540_000_000, taxPaise: 0, totalPaise: 3_540_000_000 }],
  documents: [{ kind: 'itemised_bill', source: 'invoice', title: 'INV/1', contentType: null, sha256: null, waived: false }, { kind: 'id_proof', source: 'upload', title: 'PAN', contentType: 'image/png', sha256: 'ab'.repeat(32), waived: false }],
  coverNote: 'Please process', codingFingerprint: 'x',
}
const SNAP = buildClaimSnapshot(SRC)

describe('renderClaimCopyPdf', () => {
  it('renders each copy with its banner and the RCM copy with the hash', async () => {
    const rcm = await pdfText(await renderClaimCopyPdf(SNAP, 'rcm', { snapshotSha256: 'a'.repeat(64) }))
    expect(rcm).toContain('RCM COPY - RETAINED BY HOSPITAL'); expect(rcm).toContain(`Snapshot SHA-256: ${'a'.repeat(64)}`)
    expect(rcm).toContain('CLM-2099-000001 v1 - page 1 of')
    const insurer = await pdfText(await renderClaimCopyPdf(SNAP, 'insurer'))
    expect(insurer).toContain('INSURER COPY'); expect(insurer).not.toContain('Snapshot SHA-256')
    expect(insurer).toContain('abababababab')
    expect(await pdfText(await renderClaimCopyPdf(SNAP, 'draft'))).toContain('DRAFT - NOT SUBMITTED')
    await expect(renderClaimCopyPdf(SNAP, 'rcm')).rejects.toThrow(TypeError)
  })
  it('survives non-Latin names and amounts above 2^31; the same snapshot gives the same bytes', async () => {
    const s = buildClaimSnapshot({ ...SRC, patient: { ...SRC.patient, name: 'श्रीनिवास' } })
    const text = await pdfText(await renderClaimCopyPdf(s, 'insurer'))
    expect(text).toContain('Rs. 3,54,00,000.00'); expect(text).toContain('[non-Latin text]')
    expect(Buffer.from(await renderClaimCopyPdf(SNAP, 'insurer')).equals(Buffer.from(await renderClaimCopyPdf(SNAP, 'insurer')))).toBe(true)
  })
  it('paginates long bills', async () => {
    const many = buildClaimSnapshot({ ...SRC, items: Array.from({ length: 120 }, (_, i) => ({ ...SRC.items[0], lineNo: i + 1 })) })
    const doc = await PDFDocument.load(await renderClaimCopyPdf(many, 'insurer'))
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })
})
