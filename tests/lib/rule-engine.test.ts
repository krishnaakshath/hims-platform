import { describe, it, expect } from 'vitest'
import { evaluateCriteria } from '@/lib/rule-engine'

describe('evaluateCriteria', () => {
  it('returns red if any criterion is red', () => {
    expect(evaluateCriteria([{ verdict: 'green' }, { verdict: 'red' }])).toBe('red')
  })
  it('returns yellow if any criterion is yellow and none are red', () => {
    expect(evaluateCriteria([{ verdict: 'green' }, { verdict: 'yellow' }])).toBe('yellow')
  })
  it('returns green only if all criteria are green', () => {
    expect(evaluateCriteria([{ verdict: 'green' }, { verdict: 'green' }])).toBe('green')
  })
  it('never guesses green from an empty result set', () => {
    expect(evaluateCriteria([])).toBe('yellow')
  })
})
