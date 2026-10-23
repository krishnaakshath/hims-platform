import { describe, it, expect } from 'vitest'
import { trialsEnabled, isTrialsPath, TRIALS_PATHS } from '@/lib/features'

describe('trialsEnabled', () => {
  it.each(['true', '1', ' TRUE '])('is on for %j', (v) => {
    expect(trialsEnabled({ ENABLE_TRIALS: v })).toBe(true)
  })
  it.each([undefined, '', 'false', 'yes', '0'])('is off for %j', (v) => {
    expect(trialsEnabled({ ENABLE_TRIALS: v })).toBe(false)
  })
  it('is off when the env object is empty', () => {
    expect(trialsEnabled({})).toBe(false)
  })
})

describe('isTrialsPath', () => {
  it('lists exactly the gated dashboard paths', () => {
    expect([...TRIALS_PATHS]).toEqual(['/workbook', '/trials', '/pipeline-dashboard'])
  })
  it('matches the root and nested paths', () => {
    expect(isTrialsPath('/trials')).toBe(true)
    expect(isTrialsPath('/trials/3')).toBe(true)
    expect(isTrialsPath('/workbook/x')).toBe(true)
    expect(isTrialsPath('/pipeline-dashboard')).toBe(true)
  })
  it('does not match lookalikes or other pages', () => {
    expect(isTrialsPath('/trials-x')).toBe(false)
    expect(isTrialsPath('/patients')).toBe(false)
    expect(isTrialsPath('/forms')).toBe(false)
    expect(isTrialsPath('/')).toBe(false)
  })
})
