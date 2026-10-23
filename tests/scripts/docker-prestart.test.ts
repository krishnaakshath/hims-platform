// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { decideSeedOnStart, waitFor } from '../../scripts/docker/prestart'

const empty = { patients: 0, users: 0 }

describe('decideSeedOnStart', () => {
  it('does nothing unless SEED_ON_START=true', () => {
    expect(decideSeedOnStart({}, empty)).toEqual({ seed: false, reason: 'not_requested' })
    expect(decideSeedOnStart({ SEED_ON_START: '1' }, empty)).toEqual({ seed: false, reason: 'not_requested' })
  })
  it('never seeds in production without ALLOW_PRODUCTION_SEED=1', () => {
    expect(decideSeedOnStart({ SEED_ON_START: 'true', NODE_ENV: 'production' }, empty)).toEqual({ seed: false, reason: 'production' })
    expect(decideSeedOnStart({ SEED_ON_START: 'true', NODE_ENV: 'production', ALLOW_PRODUCTION_SEED: 'true' }, empty)).toEqual({ seed: false, reason: 'production' })
    expect(decideSeedOnStart({ SEED_ON_START: 'true', NODE_ENV: 'production', ALLOW_PRODUCTION_SEED: '1' }, empty)).toEqual({ seed: true })
  })
  it('seeds only an empty database', () => {
    expect(decideSeedOnStart({ SEED_ON_START: 'true', NODE_ENV: 'development' }, empty)).toEqual({ seed: true })
    expect(decideSeedOnStart({ SEED_ON_START: 'true' }, { patients: 1, users: 0 })).toEqual({ seed: false, reason: 'not_empty' })
    expect(decideSeedOnStart({ SEED_ON_START: 'true' }, { patients: 0, users: 2 })).toEqual({ seed: false, reason: 'not_empty' })
  })
})

describe('waitFor', () => {
  it('retries until the probe passes and reports each retry by code', async () => {
    let n = 0
    const probe = vi.fn(async () => { if (++n < 3) throw Object.assign(new Error('postgres://u:p@h/db refused'), { code: 'ECONNREFUSED' }) })
    const retries: string[] = []
    const attempts = await waitFor(probe, { attempts: 5, delayMs: 0, sleep: async () => {}, onRetry: (a, c) => retries.push(`${a}:${c}`) })
    expect(attempts).toBe(3)
    expect(retries).toEqual(['1:ECONNREFUSED', '2:ECONNREFUSED'])
  })
  it('gives up after the last attempt with the probe error', async () => {
    const probe = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }) })
    await expect(waitFor(probe, { attempts: 2, delayMs: 0, sleep: async () => {} })).rejects.toMatchObject({ code: 'ENOTFOUND' })
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
