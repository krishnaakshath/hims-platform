'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Mic, MicOff, Video, VideoOff, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { TelemedicineSessionStatus } from '@/lib/queries/telemedicine-sessions'

// STUN-only, no TURN relay -- per spec §1's explicit, flagged-not-fixed
// scope boundary: a real TURN server is a real infra/vendor decision this
// codebase doesn't make unilaterally. This means some NAT topologies
// (symmetric NAT, some corporate firewalls) will fail to connect; that is a
// known, accepted limitation, not a bug in this component.
const ICE_SERVERS: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

// Signaling is short-polled (not push/websocket) -- this codebase has no
// realtime infra (see spec §2's rationale: the bed board and front-desk
// queue are both poll-based too). 1500ms sits inside spec §2's "1-2s" band.
const POLL_INTERVAL_MS = 1500

interface SignalRow {
  id: number
  sessionId: number
  sender: 'provider' | 'patient'
  signalType: 'offer' | 'answer' | 'ice_candidate'
  payload: unknown
  createdAt: string
}

interface PollResponse {
  signals: SignalRow[]
  sessionStatus: TelemedicineSessionStatus
}

type ConnectionPhase = 'connecting' | 'connected' | 'lost'

function connectionPhase(state: RTCPeerConnectionState): ConnectionPhase {
  if (state === 'connected') return 'connected'
  if (state === 'failed' || state === 'disconnected' || state === 'closed') return 'lost'
  return 'connecting'
}

const CONNECTION_LABEL: Record<ConnectionPhase, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  lost: 'Connection lost',
}

export interface TelemedicineCallScreenProps {
  role: 'provider' | 'patient'
  pollUrl: string
  initialStatus: TelemedicineSessionStatus
  onEnd?: () => void
}

export function TelemedicineCallScreen({ role, pollUrl, initialStatus, onEnd }: TelemedicineCallScreenProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSeenIdRef = useRef(0)
  const pollInFlightRef = useRef(false)

  const [sessionStatus, setSessionStatus] = useState<TelemedicineSessionStatus>(initialStatus)
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new')
  const [remoteTrackArrived, setRemoteTrackArrived] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)
  const [ended, setEnded] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)

  // Same origin, same path, for both directions -- every signaling route
  // this component talks to (Task 2 and Task 3) handles both POST (send a
  // signal) and GET (poll for the other side's signals) at the one URL the
  // caller supplies.
  const postSignal = useCallback(async (signalType: SignalRow['signalType'], payload: unknown) => {
    await fetch(pollUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalType, payload }),
    })
  }, [pollUrl])

  const teardown = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    pcRef.current?.close()
    pcRef.current = null
  }, [])

  useEffect(() => {
    let cancelled = false
    const pc = new RTCPeerConnection(ICE_SERVERS)
    pcRef.current = pc

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream ?? new MediaStream([event.track])
      setRemoteTrackArrived(true)
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) void postSignal('ice_candidate', event.candidate.toJSON())
    }

    pc.onconnectionstatechange = () => setConnectionState(pc.connectionState)

    async function poll() {
      // Reentrancy guard: setInterval doesn't wait for the previous tick's
      // fetch/negotiation chain to finish. If one poll's work (a whole
      // setRemoteDescription/createAnswer/postSignal chain for an offer, for
      // instance) outruns POLL_INTERVAL_MS, the next tick would otherwise
      // start a second, overlapping poll that could reprocess the same
      // signal and double-post an answer. pollInFlightRef makes ticks that
      // arrive while one is still running a no-op instead.
      if (pollInFlightRef.current) return
      pollInFlightRef.current = true
      try {
        await pollOnce()
      } finally {
        pollInFlightRef.current = false
      }
    }

    async function pollOnce() {
      const forParam = role === 'provider' ? '&for=patient' : ''
      let res: Response
      try {
        res = await fetch(`${pollUrl}?since=${lastSeenIdRef.current}${forParam}`)
      } catch {
        return // transient network error -- next interval tick retries
      }
      if (!res.ok) {
        // The patient-side join-token route (Task 3) deliberately 404s once
        // the session is completed/failed -- it does NOT keep returning 200
        // with sessionStatus: 'completed' (confirmed against the real
        // running route: see task-4-report.md's verification step). Once a
        // patient has successfully joined, a 404 on a later poll means the
        // provider ended the call, not a bad token -- treat it the same as
        // an explicit 'completed' status.
        if (role === 'patient' && res.status === 404 && !cancelled) {
          teardown()
          setEnded(true)
        }
        return
      }
      const data: PollResponse = await res.json()
      if (cancelled) return
      setSessionStatus(data.sessionStatus)

      for (const signal of data.signals) {
        lastSeenIdRef.current = Math.max(lastSeenIdRef.current, signal.id)
        if (signal.signalType === 'offer' && role === 'patient') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit))
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          await postSignal('answer', answer)
        } else if (signal.signalType === 'answer' && role === 'provider') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.payload as RTCSessionDescriptionInit))
        } else if (signal.signalType === 'ice_candidate') {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(signal.payload as RTCIceCandidateInit))
          } catch {
            // A candidate that arrives before setRemoteDescription (or a
            // stale/duplicate one) is not fatal to the call -- ignore and
            // rely on the other candidates already exchanged.
          }
        }
      }

      // The patient side has no "end call" route of its own (Task 3 didn't
      // build one -- ending is provider-initiated, matching Global
      // Constraints' explicit route split). It learns the call is over the
      // same way it learns anything else: the next poll's sessionStatus.
      // Not patient-only: the provider's own handleEndCall already calls
      // teardown()/setEnded() locally, but if the session is ended some
      // other way (an admin ending it from a different tab/session), the
      // provider side must also reach this terminal state instead of
      // polling forever showing a stale "Connected"/"Connecting…" status.
      if (data.sessionStatus === 'completed') {
        teardown()
        setEnded(true)
      }
    }

    async function init() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        localStreamRef.current = stream
        if (localVideoRef.current) localVideoRef.current.srcObject = stream
        stream.getTracks().forEach((track) => pc.addTrack(track, stream))

        if (role === 'provider') {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          await postSignal('offer', offer)
        }

        pollIntervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS)
      } catch {
        if (!cancelled) setMediaError('Could not access your camera and microphone. Check your browser permissions and try again.')
      }
    }
    void init()

    return () => {
      cancelled = true
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current)
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
      pc.close()
    }
    // Deliberately mount-once per (role, pollUrl) pair -- a real call
    // session is set up once; re-running this on every render would tear
    // down and rebuild the RTCPeerConnection mid-call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, pollUrl])

  async function handleEndCall() {
    // The patient side has no end route (Task 3 didn't build one -- ending
    // is provider-initiated). A patient clicking "End call" only leaves
    // *their own* call locally; it does not end the session for the
    // provider. Only the provider's click actually calls the end route.
    if (role === 'provider') {
      // Derived from pollUrl rather than a separate prop -- the caller only
      // supplies pollUrl (per this component's prop contract), and the
      // provider's pollUrl is always .../telemedicine/[sessionId]/signal, so
      // the sibling .../end route is a fixed sibling path away.
      const endUrl = pollUrl.replace(/\/signal$/, '/end')
      try {
        await fetch(endUrl, { method: 'POST' })
      } finally {
        teardown()
        setEnded(true)
        onEnd?.()
      }
      return
    }
    teardown()
    setEnded(true)
    onEnd?.()
  }

  function toggleMic() {
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !track.enabled })
    setMicOn((prev) => !prev)
  }

  function toggleCamera() {
    localStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = !track.enabled })
    setCameraOn((prev) => !prev)
  }

  if (ended) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 rounded-xl border border-border bg-card p-8 text-center">
        <p className="text-lg font-semibold text-foreground">Call ended</p>
        <p className="text-sm text-muted-foreground">You can safely close this window.</p>
      </div>
    )
  }

  if (mediaError) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-8 text-center">
        <p className="text-sm font-medium text-destructive">{mediaError}</p>
      </div>
    )
  }

  const phase = connectionPhase(connectionState)
  const showWaitingForPatient = role === 'provider' && sessionStatus === 'waiting' && !remoteTrackArrived

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2 text-sm">
        <span className="font-medium text-foreground">
          {showWaitingForPatient ? 'Waiting for patient to join…' : CONNECTION_LABEL[phase]}
        </span>
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{sessionStatus.replace('_', ' ')}</span>
      </div>

      <div className="relative grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-black">
          <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
          {!remoteTrackArrived && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/70">
              {showWaitingForPatient ? 'Waiting for patient to join…' : 'Waiting for the other side…'}
            </div>
          )}
        </div>
        <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-black">
          <video ref={localVideoRef} autoPlay muted playsInline className="h-full w-full object-cover" />
          <span className="absolute bottom-2 left-2 rounded bg-black/50 px-1.5 py-0.5 text-xs text-white">You</span>
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <Button type="button" variant={micOn ? 'outline' : 'destructive'} size="icon" onClick={toggleMic} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}>
          {micOn ? <Mic /> : <MicOff />}
        </Button>
        <Button type="button" variant={cameraOn ? 'outline' : 'destructive'} size="icon" onClick={toggleCamera} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}>
          {cameraOn ? <Video /> : <VideoOff />}
        </Button>
        <Button type="button" variant="destructive" onClick={handleEndCall}>
          <PhoneOff /> End call
        </Button>
      </div>
    </div>
  )
}
