// Client-safe (no server imports): the body a route answers with when a backing service is
// missing, and the message staff see. Never carries an env var name.
export type Service = 'database' | 'redis' | 'blob'

export const STORAGE_NOT_CONFIGURED_MESSAGE = 'File storage is not set up. Ask your administrator.'
export const SERVICE_UNAVAILABLE_TEXT = 'Service temporarily unavailable'

export type ServiceUnavailableBody = { error: string; code: 'storage_not_configured' | 'service_unavailable' }

export function serviceUnavailableBody(service: Service): ServiceUnavailableBody {
  return service === 'blob'
    ? { error: STORAGE_NOT_CONFIGURED_MESSAGE, code: 'storage_not_configured' }
    : { error: SERVICE_UNAVAILABLE_TEXT, code: 'service_unavailable' }
}
