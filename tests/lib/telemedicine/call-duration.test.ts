import { describe, it, expect } from 'vitest'
import { formatCallDuration, formatCallClock } from '@/lib/telemedicine/call-duration'

const start = new Date('2026-10-23T04:30:00Z')
const plus = (ms: number) => new Date(start.getTime() + ms)
const MIN = 60_000

describe('formatCallDuration', () => {
  it('says "under a minute" for a short call, a call that never started, or a clock skew', () => {
    expect(formatCallDuration(start, plus(59_999))).toBe('under a minute')
    expect(formatCallDuration(null, plus(30 * MIN))).toBe('under a minute')
    expect(formatCallDuration(start, plus(-5 * MIN))).toBe('under a minute')
  })

  it('gives whole minutes under an hour', () => {
    expect(formatCallDuration(start, plus(MIN))).toBe('1 min')
    expect(formatCallDuration(start, plus(12 * MIN + 59_000))).toBe('12 min')
    expect(formatCallDuration(start, plus(59 * MIN))).toBe('59 min')
  })

  it('gives hours and zero-padded minutes from an hour', () => {
    expect(formatCallDuration(start, plus(60 * MIN))).toBe('1 h 00 min')
    expect(formatCallDuration(start, plus(65 * MIN))).toBe('1 h 05 min')
    expect(formatCallDuration(start, plus(134 * MIN))).toBe('2 h 14 min')
  })
})

describe('formatCallClock', () => {
  it('renders elapsed time as mm:ss, minutes unbounded', () => {
    expect(formatCallClock(0)).toBe('00:00')
    expect(formatCallClock(5_400)).toBe('00:05')
    expect(formatCallClock(12 * MIN + 3_000)).toBe('12:03')
    expect(formatCallClock(75 * MIN)).toBe('75:00')
    expect(formatCallClock(-1_000)).toBe('00:00')
  })
})
