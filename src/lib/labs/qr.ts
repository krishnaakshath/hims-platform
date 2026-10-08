// SP5: QR module matrix for sample labels. Rendered as <svg> <rect>s by SampleLabelSheet, so no
// generated markup string ever reaches innerHTML. The encoded text is the canonical sample ID.
import QRCode from 'qrcode'

/** Row-major dark/light modules of the QR code for `text` (error correction M). */
export function qrModules(text: string): { size: number; dark: boolean[] } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const dark: boolean[] = new Array(modules.size * modules.size)
  for (let r = 0; r < modules.size; r++) {
    for (let c = 0; c < modules.size; c++) dark[r * modules.size + c] = modules.get(r, c) === 1
  }
  return { size: modules.size, dark }
}
