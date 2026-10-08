import { readAbdmConfig } from '@/lib/integrations/config'
import type { AbdmGateway } from './gateway'
import { httpAbdmGateway } from './http-adapter'
import { mockAbdmGateway } from './mock-adapter'

// The one place that chooses the ABDM gateway (ruling 1): real credentials ->
// the ABHA V3 adapter; no credentials but mocks enabled outside production ->
// the labelled sandbox mock; otherwise null, which routes answer with
// 503 'ABDM is not configured'. The mock module is imported only here.
export function getAbdmGateway(env: Record<string, string | undefined> = process.env): AbdmGateway | null {
  const cfg = readAbdmConfig(env)
  if (cfg.state === 'configured') return httpAbdmGateway(cfg.config)
  if (cfg.state === 'mock') return mockAbdmGateway()
  return null
}
