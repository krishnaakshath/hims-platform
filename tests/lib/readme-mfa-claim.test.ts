// WS7 T7 (spec D13): the README must not claim patient MFA is mandatory; staff MFA is.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8').replace(/\s+/g, ' ')

describe('README MFA claims', () => {
  it('never says patient MFA is mandatory', () => {
    expect(readme).not.toMatch(/mandatory[^.]*patient/i)
    expect(readme).not.toMatch(/patient[^.]*mandatory/i)
  })

  it('states staff MFA is required and patient MFA is offered with OTP sign-in', () => {
    expect(readme).toMatch(/staff[^.]*MFA[^.]*required|MFA[^.]*required[^.]*staff/i)
    expect(readme).toMatch(/patient[^.]*(offered|optional)[^.]*recommended/i)
    expect(readme).toMatch(/one-time code|OTP sign-in/i)
  })
})
