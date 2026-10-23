// The bytes decide an upload's type, never its name or the declared MIME type: an .exe renamed
// .pdf is still an .exe. Shared by the intake file question (WS7 T3) and the portal self-service
// card image (WS7 T9). PDF, JPEG and PNG only.
export interface SniffedUpload { contentType: 'application/pdf' | 'image/jpeg' | 'image/png'; fileType: 'PDF' | 'JPG' | 'PNG' }

const SIGNATURES: (SniffedUpload & { magic: number[] })[] = [
  { contentType: 'application/pdf', fileType: 'PDF', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { contentType: 'image/jpeg', fileType: 'JPG', magic: [0xff, 0xd8, 0xff] },
  { contentType: 'image/png', fileType: 'PNG', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
]

export function sniffUpload(bytes: Uint8Array): SniffedUpload | null {
  const s = SIGNATURES.find((sig) => sig.magic.every((b, i) => bytes[i] === b))
  return s ? { contentType: s.contentType, fileType: s.fileType } : null
}
