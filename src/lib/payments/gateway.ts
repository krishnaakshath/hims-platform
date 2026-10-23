// Foundations T11: placeholder for an online payment gateway. No gateway is integrated, so it
// always reports not configured and refuses every call; nothing reaches the ledger through it.
import { PaymentProviderError, type PaymentProvider } from './provider'

export const gatewayProvider: PaymentProvider & { status(): { configured: false; reason: string } } = {
  name: 'gateway',
  status: () => ({ configured: false, reason: 'No online payment gateway is integrated. Use the cash desk modes or UPI QR.' }),
  createRequest: async () => { throw new PaymentProviderError('not_configured') },
  recordConfirmation: async () => { throw new PaymentProviderError('not_configured') },
}
