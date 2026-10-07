// SP5 Task 9: the QR module matrix behind the sample labels.
import { describe, it, expect } from 'vitest'
import QRCode from 'qrcode'
import { qrModules } from '@/lib/labs/qr'

describe('qrModules', () => {
  it('produces a square module matrix', () => {
    const m = qrModules('L26100800429')
    expect(m.dark.length).toBe(m.size * m.size)
    expect(m.size).toBeGreaterThanOrEqual(21)
    expect(m.dark.some(Boolean)).toBe(true)
  })

  it('matches the qrcode library at error-correction level M, row-major', () => {
    const ref = QRCode.create('L26100800429', { errorCorrectionLevel: 'M' }).modules
    const m = qrModules('L26100800429')
    expect(m.size).toBe(ref.size)
    for (let r = 0; r < ref.size; r++) {
      for (let c = 0; c < ref.size; c++) expect(m.dark[r * m.size + c]).toBe(ref.get(r, c) === 1)
    }
  })

  it('is deterministic and differs for a different ID', () => {
    expect(qrModules('L26100800429')).toEqual(qrModules('L26100800429'))
    expect(qrModules('L26100800429').dark).not.toEqual(qrModules('L26100800438').dark)
  })
})
