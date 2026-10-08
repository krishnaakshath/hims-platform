import { describe, it, expect } from 'vitest'
import { getAbdmGateway } from '@/lib/abdm/registry'

const FULL_ABDM = {
  ABDM_GATEWAY_BASE_URL: 'https://dev.abdm.gov.in', ABHA_BASE_URL: 'https://abhasbx.abdm.gov.in', ABDM_CLIENT_ID: 'cid', ABDM_CLIENT_SECRET: 'csec', ABDM_CM_ID: 'sbx',
}

describe('getAbdmGateway', () => {
  it('returns null, mock or http by configuration', () => {
    expect(getAbdmGateway({ NODE_ENV: 'production', ABDM_USE_MOCKS: '1' })).toBeNull()
    expect(getAbdmGateway({ NODE_ENV: 'development' })).toBeNull()
    expect(getAbdmGateway({ NODE_ENV: 'development', ABDM_USE_MOCKS: '1' })!.source).toBe('abdm_sandbox_mock')
    expect(getAbdmGateway(FULL_ABDM)!.source).toBe('abdm')
    expect(getAbdmGateway({ ...FULL_ABDM, NODE_ENV: 'development', ABDM_USE_MOCKS: '1' })!.source).toBe('abdm')
  })
})
