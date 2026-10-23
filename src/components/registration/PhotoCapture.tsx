'use client'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

// WS6 T8: the patient's photo at registration. Uses the device camera
// (navigator.mediaDevices.getUserMedia) when the browser offers one, and a file
// input otherwise -- or when the camera is refused. The captured file is handed
// up; the dialog uploads it once the patient exists (POST /api/patients/[anonId]/photo).

export const PHOTO_MAX_BYTES = 2 * 1024 * 1024
const ACCEPT = 'image/jpeg,image/png,image/webp'

type Mode = 'idle' | 'camera' | 'file'

function cameraAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export function PhotoCapture({ onCaptured }: { onCaptured(file: File): void }) {
  const [mode, setMode] = useState<Mode>(() => (cameraAvailable() ? 'idle' : 'file'))
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  function stopCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  useEffect(() => () => {
    stopCamera()
  }, [])

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview)
  }, [preview])

  function accept(file: File) {
    if (file.size > PHOTO_MAX_BYTES) {
      setError('The photo must be 2 MB or smaller.')
      return
    }
    setError(null)
    setPreview(typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null)
    onCaptured(file)
  }

  async function startCamera() {
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      streamRef.current = stream
      setMode('camera')
      // The video element mounts with the camera mode; attach on the next frame.
      requestAnimationFrame(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play().catch(() => undefined)
        }
      })
    } catch {
      setError('The camera is not available. Choose a photo file instead.')
      setMode('file')
    }
  }

  function takePhoto() {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) {
        setError('Could not take the photo. Try again or choose a file.')
        return
      }
      stopCamera()
      setMode('idle')
      accept(new File([blob], 'patient-photo.jpg', { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.85)
  }

  return (
    <section aria-label="Photo" className="space-y-2">
      <p className="text-xs font-medium text-foreground">Patient photo (optional)</p>
      <div className="flex items-start gap-3">
        {preview
          // eslint-disable-next-line @next/next/no-img-element -- a local object URL preview, not a remote image
          ? <img src={preview} alt="Captured patient photo" className="size-20 rounded-md border border-border object-cover" />
          : <div aria-hidden="true" className="size-20 rounded-md border border-dashed border-border bg-muted" />}
        <div className="space-y-2">
          {mode === 'idle' && (
            <Button type="button" variant="outline" size="sm" onClick={startCamera}>{preview ? 'Retake photo' : 'Use camera'}</Button>
          )}
          {mode === 'camera' && (
            <div className="space-y-2">
              <video ref={videoRef} muted playsInline className="h-32 w-44 rounded-md bg-black" />
              <div className="flex gap-2">
                <Button type="button" size="sm" onClick={takePhoto}>Take photo</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => { stopCamera(); setMode('idle') }}>Cancel</Button>
              </div>
            </div>
          )}
          {mode === 'file' && (
            <input
              type="file"
              accept={ACCEPT}
              aria-label="Patient photo file"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) accept(f) }}
              className="block text-xs"
            />
          )}
          <p className="text-xs text-muted-foreground">JPEG, PNG or WebP, up to 2 MB. Saved after the patient is registered.</p>
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  )
}
