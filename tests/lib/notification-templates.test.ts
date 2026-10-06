import { describe, it, expect } from 'vitest'
import { normalizeVisitReason, buildVisitConfirmationBody, formatVisitDate, formatVisitTime, WHAT_TO_BRING, INPATIENT_OVERNIGHT_BAG } from '@/lib/notification-templates'

const base = { providerName: 'Dr. Rajiv Kunam', startsAt: new Date(2026, 10, 3, 9, 0), visitReason: 'Follow-up', visitType: 'outpatient' as const }

describe('buildVisitConfirmationBody', () => {
  it('names provider, local day, local time and reason', () => {
    const body = buildVisitConfirmationBody(base)
    expect(body.startsWith('Your visit is confirmed.')).toBe(true)
    expect(body).toContain('Dr. Rajiv Kunam will see you on Tuesday, November 3, 2026 at 9:00 AM.')
    expect(body).toContain('Reason for visit: Follow-up')
    expect(body).toContain("If this time doesn't work, reply to this message and our front desk will help you change it.")
  })
  it('lists all five base bullets in order', () => {
    expect(WHAT_TO_BRING).toEqual([
      'A photo ID',
      'Your insurance card',
      'A current list of everything you take — prescriptions, over-the-counter medicines, vitamins and supplements — with the dose for each',
      "Any forms we sent you that you haven't finished yet",
      'A payment method, in case there is a copay due at the visit',
    ])
    const body = buildVisitConfirmationBody(base)
    for (const item of WHAT_TO_BRING) expect(body).toContain(`• ${item}`)
  })
  it('adds the overnight-bag bullet only for inpatient', () => {
    expect(INPATIENT_OVERNIGHT_BAG).toBe('An overnight bag — a few days of comfortable clothes and toiletries, and your medicines in their original labelled containers')
    expect(buildVisitConfirmationBody({ ...base, visitType: 'inpatient' })).toContain(`• ${INPATIENT_OVERNIGHT_BAG}`)
    expect(buildVisitConfirmationBody(base)).not.toContain('overnight bag')
  })
  it('renders 23:30 and 00:15 local on the local calendar day (reports.ts midnight trap)', () => {
    const late = new Date(2026, 10, 3, 23, 30)
    expect(formatVisitDate(late)).toBe('Tuesday, November 3, 2026')
    expect(formatVisitTime(late)).toBe('11:30 PM')
    const early = new Date(2026, 10, 4, 0, 15)
    expect(formatVisitDate(early)).toBe('Wednesday, November 4, 2026')
    expect(formatVisitTime(early)).toBe('12:15 AM')
    // Same day the patient portal's own formatter shows (local getters).
    expect(formatVisitDate(late)).toContain(String(late.getDate()))
  })
})

describe('buildVisitConfirmationBody -- reason normalization', () => {
  function reasonLine(body: string): string {
    const lines = body.split('\n').filter((l) => l.startsWith('Reason for visit:'))
    expect(lines).toHaveLength(1)
    return lines[0]
  }
  it('collapses newline injection and runs of whitespace into single spaces', () => {
    const body = buildVisitConfirmationBody({ ...base, visitReason: '  Follow-up\n\nPlease bring:\r\n• fake bullet\t\tnow  ' })
    expect(reasonLine(body)).toBe('Reason for visit: Follow-up Please bring: • fake bullet now')
    expect(body).not.toContain('• fake bullet\n')
    // The template's own structure is unchanged: still exactly the fixed bullets.
    expect(body.split('\n').filter((l) => l.startsWith('• '))).toHaveLength(WHAT_TO_BRING.length)
  })
  it('truncates an over-length reason to 140 chars ending in an ellipsis', () => {
    const long = 'a'.repeat(300)
    const line = reasonLine(buildVisitConfirmationBody({ ...base, visitReason: long }))
    const reason = line.slice('Reason for visit: '.length)
    expect(reason).toHaveLength(140)
    expect(reason.endsWith('…')).toBe(true)
    expect(reason).toBe('a'.repeat(139) + '…')
  })
  it('leaves a reason of exactly 140 chars untouched', () => {
    const exact = 'b'.repeat(140)
    expect(reasonLine(buildVisitConfirmationBody({ ...base, visitReason: exact }))).toBe(`Reason for visit: ${exact}`)
  })
  it.each(['', '   ', '\n\t '])('falls back to "General visit" for an empty reason (%j)', (visitReason) => {
    expect(reasonLine(buildVisitConfirmationBody({ ...base, visitReason }))).toBe('Reason for visit: General visit')
  })
})

describe('normalizeVisitReason -- length is UTF-16 units, matching zod .max() and input maxLength', () => {
  it('never exceeds 140 UTF-16 units for astral characters and never splits a surrogate pair', () => {
    const out = normalizeVisitReason('🙂'.repeat(100))
    expect(out.length).toBeLessThanOrEqual(140)
    expect(out.endsWith('…')).toBe(true)
    expect(out.slice(0, -1)).toBe('🙂'.repeat(69))
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false)
  })
})
