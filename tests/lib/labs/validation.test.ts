import { describe, it, expect } from 'vitest'
import {
  labResultSchema, labOrderCancelSchema, receiveSampleSchema, createLabRequisitionSchema, servicePinsRequestSchema,
  servicePinPatchSchema, collectionWindowSchema, collectionWindowPatchSchema, labTestSetupSchema, visitAddressSchema,
  bookHomeCollectionSchema, rescheduleHomeCollectionSchema, cancelHomeCollectionSchema, assignCollectorSchema,
  collectHomeVisitSchema, notificationPreferenceSchema,
} from '@/lib/labs/validation'

describe('SP5 validation', () => {
  it('createLabRequisitionSchema accepts the legacy body and normalises it', () => {
    expect(createLabRequisitionSchema.parse({ labTestId: 3 })).toEqual({ labTestIds: [3], followUp: null, originatingEncounterId: null })
    expect(createLabRequisitionSchema.safeParse({ labTestIds: [3, 3] }).success).toBe(false)
    expect(createLabRequisitionSchema.safeParse({ labTestIds: [] }).success).toBe(false)
    expect(createLabRequisitionSchema.safeParse({ labTestIds: Array.from({ length: 21 }, (_, i) => i + 1) }).success).toBe(false)
    expect(createLabRequisitionSchema.safeParse({ labTestIds: [3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: 'Review LFT' } }).success).toBe(true)
    expect(createLabRequisitionSchema.parse({ labTestIds: [3, 4], originatingEncounterId: 7 }))
      .toEqual({ labTestIds: [3, 4], followUp: null, originatingEncounterId: 7 })
    expect(createLabRequisitionSchema.parse({ labTestIds: [3], followUp: { interval: { value: 2, unit: 'weeks' }, reason: ' Review LFT ' } }).followUp)
      .toEqual({ interval: { value: 2, unit: 'weeks' }, reason: 'Review LFT' })
    expect(createLabRequisitionSchema.safeParse({ labTestId: 3, extra: 1 }).success).toBe(false)
    expect(createLabRequisitionSchema.safeParse({ labTestId: 0 }).success).toBe(false)
  })

  it('labResultSchema is strict and bounded', () => {
    expect(labResultSchema.parse({ value: ' 5.4 ', flag: 'normal' })).toEqual({ value: '5.4', flag: 'normal' })
    expect(labResultSchema.safeParse({ value: '', flag: 'normal' }).success).toBe(false)
    expect(labResultSchema.safeParse({ value: '1', flag: 'high' }).success).toBe(false)
    expect(labResultSchema.safeParse({ value: '1', flag: 'normal', extra: 1 }).success).toBe(false)
    expect(labOrderCancelSchema.safeParse({ reason: '   ' }).success).toBe(false)
    expect(receiveSampleSchema.parse({ sampleId: ' L261008-0042-9 ' })).toEqual({ sampleId: 'L261008-0042-9' })
  })

  it('bookHomeCollectionSchema normalises the phone and validates PIN/state', () => {
    const ok = {
      patientId: 'RD-0001', labOrderIds: [1], visitDate: '2099-01-10', windowId: 1, contactPhone: '98450 12345',
      address: { line1: '12 MG Road', city: 'Bengaluru', stateCode: 'IN-KA', pinCode: '560001' },
    }
    expect(bookHomeCollectionSchema.parse(ok).contactPhone).toBe('+919845012345')
    expect(bookHomeCollectionSchema.parse({ ...ok, contactPhone: '080 2222 3333' }).contactPhone).toBe('+918022223333')
    expect(bookHomeCollectionSchema.safeParse({ ...ok, address: { ...ok.address, pinCode: '060001' } }).success).toBe(false)
    expect(bookHomeCollectionSchema.safeParse({ ...ok, address: { ...ok.address, stateCode: 'XX' } }).success).toBe(false)
    const bad = bookHomeCollectionSchema.safeParse({ ...ok, contactPhone: '123' })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0].message).toBe('Enter a valid phone number')
    expect(bookHomeCollectionSchema.safeParse({ ...ok, labOrderIds: [1, 1] }).success).toBe(false)
    expect(bookHomeCollectionSchema.safeParse({ ...ok, visitDate: '2099-02-30' }).success).toBe(false)
  })

  it('visitAddressSchema trims and bounds', () => {
    expect(visitAddressSchema.safeParse({ line1: ' ', city: 'X', stateCode: 'IN-KA', pinCode: '560001' }).success).toBe(false)
  })

  it('collectionWindowSchema requires start before end', () => {
    expect(collectionWindowSchema.safeParse({ label: 'Early', startTime: '09:00', endTime: '07:00', capacity: 5 }).success).toBe(false)
    expect(collectionWindowSchema.safeParse({ label: 'Early', startTime: '07:00', endTime: '09:00', capacity: 5 }).success).toBe(true)
    expect(collectionWindowSchema.safeParse({ label: 'Early', startTime: '07:00', endTime: '09:00', capacity: 51 }).success).toBe(false)
    expect(collectionWindowSchema.safeParse({ label: 'Early', startTime: '7:00', endTime: '09:00', capacity: 5 }).success).toBe(false)
  })

  it('collectionWindowPatchSchema needs a key and an ordered pair', () => {
    expect(collectionWindowPatchSchema.safeParse({}).success).toBe(false)
    expect(collectionWindowPatchSchema.safeParse({ isActive: false }).success).toBe(true)
    expect(collectionWindowPatchSchema.safeParse({ startTime: '10:00', endTime: '09:00' }).success).toBe(false)
    expect(collectionWindowPatchSchema.safeParse({ startTime: '10:00' }).success).toBe(true)
  })

  it('setup, pins, visit actions and preferences', () => {
    expect(labTestSetupSchema.safeParse({}).success).toBe(false)
    expect(labTestSetupSchema.safeParse({ sampleType: null }).success).toBe(true)
    expect(labTestSetupSchema.safeParse({ container: 'edta_lavender', serviceId: 4 }).success).toBe(true)
    expect(labTestSetupSchema.safeParse({ sampleType: 'saliva' }).success).toBe(false)
    expect(servicePinsRequestSchema.safeParse({ pins: '560001', areaLabel: 'Central' }).success).toBe(true)
    expect(servicePinsRequestSchema.safeParse({ pins: 'x'.repeat(5001) }).success).toBe(false)
    expect(servicePinPatchSchema.safeParse({ isActive: 'yes' }).success).toBe(false)
    expect(rescheduleHomeCollectionSchema.safeParse({ visitDate: '2099-01-10', windowId: 2, reason: 'patient_request' }).success).toBe(true)
    expect(rescheduleHomeCollectionSchema.safeParse({ visitDate: '2099-01-10', windowId: 2, reason: 'whim' }).success).toBe(false)
    expect(cancelHomeCollectionSchema.safeParse({ reason: 'address_not_found', note: 'gate locked' }).success).toBe(true)
    expect(assignCollectorSchema.safeParse({ collectorUserId: null }).success).toBe(true)
    expect(assignCollectorSchema.safeParse({ collectorUserId: 0 }).success).toBe(false)
    expect(collectHomeVisitSchema.safeParse({ sampleIds: [] }).success).toBe(false)
    expect(collectHomeVisitSchema.parse({ sampleIds: [' L26100800429 '] })).toEqual({ sampleIds: ['L26100800429'] })
    expect(notificationPreferenceSchema.safeParse({ optOut: true }).success).toBe(true)
    expect(notificationPreferenceSchema.safeParse({ optOut: true, x: 1 }).success).toBe(false)
  })
})
