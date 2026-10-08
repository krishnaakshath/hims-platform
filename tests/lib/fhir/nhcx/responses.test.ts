import { describe, it, expect } from 'vitest'
import {
  buildCommunicationResponseTaskBundle, buildPaymentAckTaskBundle, parseClaimResponseBundle, parseCommunicationRequestTaskBundle, parsePaymentNoticeTaskBundle,
} from '@/lib/fhir/nhcx/responses'
import { validateNhcxBundle } from '@/lib/fhir/nhcx/validate'
import { fixture, HOSPITAL, TPA, type AnyJson } from './fixtures'

describe('NHCX responses', () => {
  it('parses the official settlement response without treating eligpercent as approval', () => {
    expect(parseClaimResponseBundle(fixture('Bundle-ClaimResponseBundle-settlement-example-01'))).toMatchObject({ ok: true, summary: { outcome: 'complete', use: 'claim', submittedPaise: 90_000_00, benefitPaise: null } })
  })
  it('the pre-auth response carries the reference outside the summary', () => {
    const r: AnyJson = parseClaimResponseBundle(fixture('Bundle-ClaimResponseBundle-preauthorization-example-01'))
    expect(r).toMatchObject({ ok: true, preAuthRef: '123456', summary: { use: 'preauthorization', preAuthRefPresent: true, adjudicationReasonCodes: ['covered'] } })
    expect(JSON.stringify(r.summary)).not.toMatch(/123456|authorized/)
    expect(r.dispositionText).toMatch(/authorized/)
  })
  it('reads a benefit total as the approved amount', () => {
    const b = fixture('Bundle-ClaimResponseBundle-settlement-example-01')
    b.entry[0].resource.total.push({ category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/adjudication', code: 'benefit' }] }, amount: { value: 85000.5, currency: 'INR' } })
    expect(parseClaimResponseBundle(b)).toMatchObject({ ok: true, summary: { benefitPaise: 8_500_050 } })
  })
  it('reads a communication request and builds a response that validates', () => {
    const req = fixture('Bundle-TaskBundleForCommunicationRequest-example-01')
    const r = parseCommunicationRequestTaskBundle(req); expect(r).toMatchObject({ ok: true, text: expect.stringMatching(/Angeography report/), requestIdentifier: '4524657454', summary: { hasQueryText: true } })
    const resp: AnyJson = buildCommunicationResponseTaskBundle({ request: { identifier: '4524657454', fullBundle: req }, text: 'Report attached', attachments: [{ contentType: 'application/pdf', title: 'Angiography report', dataBase64: 'JVBERi0=' }], created: new Date('2026-10-08T06:00:00Z'), hospital: HOSPITAL, payer: TPA })
    expect(validateNhcxBundle(resp, 'TaskBundle')).toEqual([])
    const comm = resp.entry[1].resource
    expect(comm).toMatchObject({ resourceType: 'Communication', status: 'completed', payload: [{ contentString: 'Report attached' }, { contentAttachment: { title: 'Angiography report' } }] })
    expect(resp.entry.some((e: AnyJson) => e.fullUrl === comm.basedOn[0].reference)).toBe(true)
  })
  it('reads a payment notice and builds the paymentack', () => {
    expect(parsePaymentNoticeTaskBundle(fixture('Bundle-TaskBundleForPaymentNoticeRequest-example-01'))).toMatchObject({ ok: true, summary: { paymentAmountPaise: 1_80_000_00, paymentDate: '2025-03-07' } })
    const ack: AnyJson = buildPaymentAckTaskBundle({ created: new Date(), hospital: HOSPITAL, payer: TPA })
    expect(ack.entry[0].resource.output[0].valueCodeableConcept.coding[0].code).toBe('paymentack')
    expect(validateNhcxBundle(ack, 'TaskBundle')).toEqual([])
  })
  it('a bundle of the wrong kind is a problem, not a throw', () => {
    expect(parseClaimResponseBundle({}).ok).toBe(false)
    expect(parseCommunicationRequestTaskBundle(fixture('Bundle-TaskBundleForPaymentNoticeRequest-example-01')).ok).toBe(false)
    expect(parsePaymentNoticeTaskBundle(null).ok).toBe(false)
  })
})
