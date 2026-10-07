import { describe, it, expect } from 'vitest'
import { normalizeVisitReason, buildVisitConfirmationBody, formatVisitDate, formatVisitTime, WHAT_TO_BRING, INPATIENT_OVERNIGHT_BAG } from '@/lib/notification-templates'

// 09:00 IST on Tue 3 Nov 2026 (= 03:30Z). Built from an explicit instant so the
// result never depends on the test machine's (or the server's) time zone.
const base = { providerName: 'Dr. Rajiv Kunam', startsAt: new Date('2026-11-03T09:00:00+05:30'), visitReason: 'Follow-up', visitType: 'outpatient' as const }

describe('buildVisitConfirmationBody', () => {
  it('names provider, IST day, IST time (labelled) and reason', () => {
    const body = buildVisitConfirmationBody(base)
    expect(body.startsWith('Your visit is confirmed.')).toBe(true)
    expect(body).toContain('Dr. Rajiv Kunam will see you on Tuesday, 3 November 2026 at 9:00 am IST.')
    expect(body).toContain('Reason for visit: Follow-up')
    expect(body).toContain("If this time doesn't work, reply to this message and our front desk will help you change it.")
  })
  it('lists all five base bullets in order', () => {
    expect(WHAT_TO_BRING).toEqual([
      'A photo ID (for example Aadhaar, PAN card, voter ID or passport)',
      'Your health insurance, TPA or government scheme card, if you have one',
      'A current list of everything you take — prescriptions, over-the-counter medicines, vitamins and supplements — with the dose for each',
      "Any forms we sent you that you haven't finished yet",
      'A way to pay (cash, UPI or card) for any amount due at the visit',
    ])
    const body = buildVisitConfirmationBody(base)
    for (const item of WHAT_TO_BRING) expect(body).toContain(`• ${item}`)
  })
  it('adds the overnight-bag bullet only for inpatient', () => {
    expect(INPATIENT_OVERNIGHT_BAG).toBe('An overnight bag — a few days of comfortable clothes and toiletries, and your medicines in their original labelled containers')
    expect(buildVisitConfirmationBody({ ...base, visitType: 'inpatient' })).toContain(`• ${INPATIENT_OVERNIGHT_BAG}`)
    expect(buildVisitConfirmationBody(base)).not.toContain('overnight bag')
  })
  it('renders 23:30 and 00:15 IST on the IST calendar day (midnight trap)', () => {
    const late = new Date('2026-11-03T18:00:00Z') // 23:30 IST, 3 Nov
    expect(formatVisitDate(late)).toBe('Tuesday, 3 November 2026')
    expect(formatVisitTime(late)).toBe('11:30 pm IST')
    const early = new Date('2026-11-03T18:45:00Z') // 00:15 IST, 4 Nov (still 3 Nov in UTC)
    expect(formatVisitDate(early)).toBe('Wednesday, 4 November 2026')
    expect(formatVisitTime(early)).toBe('12:15 am IST')
  })
  it('a 09:00 IST visit is never told to the patient as 2:30 pm (server running in UTC)', () => {
    const body = buildVisitConfirmationBody({ ...base, startsAt: new Date('2026-11-03T03:30:00Z') })
    expect(body).toContain('at 9:00 am IST.')
    expect(body).not.toMatch(/2:30|AM|PM/)
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
