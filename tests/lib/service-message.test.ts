import { describe, it, expect } from 'vitest'
import { serviceUnavailableBody, STORAGE_NOT_CONFIGURED_MESSAGE } from '@/lib/http/service-message'

describe('serviceUnavailableBody', () => {
  it('names missing storage in plain words', () => {
    expect(serviceUnavailableBody('blob')).toEqual({ error: 'File storage is not set up. Ask your administrator.', code: 'storage_not_configured' })
    expect(STORAGE_NOT_CONFIGURED_MESSAGE).toBe('File storage is not set up. Ask your administrator.')
  })
  it('is generic for other services', () => {
    expect(serviceUnavailableBody('redis')).toEqual({ error: 'Service temporarily unavailable', code: 'service_unavailable' })
    expect(serviceUnavailableBody('database').code).toBe('service_unavailable')
  })
})
