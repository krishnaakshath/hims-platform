import { describe, it, expect } from 'vitest'
import { QUEUE_LABELS, queueLabels } from '@/lib/queue-display-i18n'

describe('queue display labels', () => {
  it('has every label in English, Hindi and Kannada', () => {
    for (const lang of ['en', 'hi', 'kn'] as const) {
      for (const key of ['nowServing', 'waiting', 'ready', 'room', 'noTickets', 'urgent', 'emergency'] as const) {
        expect(QUEUE_LABELS[lang][key].trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('writes Hindi in Devanagari and Kannada in Kannada script', () => {
    for (const value of Object.values(QUEUE_LABELS.hi)) expect(value).toMatch(/[ऀ-ॿ]/)
    for (const value of Object.values(QUEUE_LABELS.kn)) expect(value).toMatch(/[ಀ-೿]/)
  })

  it('picks the language and falls back to English for unknown or missing', () => {
    expect(queueLabels('kn')).toBe(QUEUE_LABELS.kn)
    expect(queueLabels('hi')).toBe(QUEUE_LABELS.hi)
    expect(queueLabels('en').nowServing).toBe('Now serving')
    expect(queueLabels('xx')).toBe(QUEUE_LABELS.en)
    expect(queueLabels(null)).toBe(QUEUE_LABELS.en)
  })
})
