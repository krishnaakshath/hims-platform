// Wave H P1-26: the user actions the audit found failing invisibly now show
// the failure in a role="alert" element and leave the control usable.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { CLIENT_ERROR_MESSAGES, mockFetch, mockFetchReject } from './helpers'

const router = { refresh: vi.fn(), push: vi.fn() }
vi.mock('next/navigation', () => ({ useRouter: () => router }))
afterEach(() => { vi.unstubAllGlobals(); router.refresh.mockClear(); router.push.mockClear() })

import { SendFormModal } from '@/components/SendFormModal'
import { DiscrepancyList } from '@/components/DiscrepancyList'
import { StaffLoginForm } from '@/components/StaffLoginForm'
import { StaffManagementPanel } from '@/components/settings/StaffManagementPanel'
import { TelemedicineCallScreen } from '@/components/TelemedicineCallScreen'

function fillSendForm() {
  const selects = screen.getByRole('dialog').querySelectorAll('select')
  fireEvent.change(selects[0], { target: { value: 'RD-0001' } })
  fireEvent.change(selects[1], { target: { value: '1' } })
}

describe('SendFormModal', () => {
  const props = { templates: [{ id: 1, name: 'Intake' }], patients: [{ id: 'RD-0001', name: 'Jane' }] }
  it('shows a failed send in an alert, keeps the dialog open and Send enabled', async () => {
    mockFetch(500, { error: 'insert failed: duplicate key' })
    const onClose = vi.fn()
    render(<SendFormModal {...props} onClose={onClose} />)
    fillSendForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send Form' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(screen.getByRole('alert')).not.toHaveTextContent('duplicate key')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Send Form' })).toBeEnabled()
  })

  it('shows the intake link after a successful send', async () => {
    mockFetch(201, { id: 9, accessToken: 'tok123' })
    const onClose = vi.fn()
    render(<SendFormModal {...props} onClose={onClose} />)
    fillSendForm()
    fireEvent.click(screen.getByRole('button', { name: 'Send Form' }))
    const link = await screen.findByLabelText('Intake link')
    expect((link as HTMLInputElement).value).toMatch(/\/intake\/tok123$/)
    expect(router.refresh).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('DiscrepancyList', () => {
  const rows = [{ id: 3, questionLabel: 'Allergies', patientAnswer: 'None', chartFinding: 'Penicillin', resolved: false, resolvedBy: null, createdAt: '2026-10-01T00:00:00Z' }]
  it('does not reload on a failed resolve; shows why and re-enables the button', async () => {
    mockFetch(404, { error: 'Not found' })
    render(<DiscrepancyList discrepancies={rows} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Not found')
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeEnabled()
  })
})

describe('StaffLoginForm', () => {
  const portal = { key: 'crc', label: 'Coordinator', description: 'd', icon: () => null, iconBg: '', iconText: '' }
  async function signIn() {
    render(<StaffLoginForm portal={portal} />)
    fireEvent.change(screen.getByLabelText('Email Address'), { target: { value: 'a@b.co' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
  }
  it.each([
    [401, { error: 'Invalid email or password' }, 'Invalid email or password.'],
    [429, { error: 'bucket' }, CLIENT_ERROR_MESSAGES.tooMany],
    [500, { error: 'db down' }, CLIENT_ERROR_MESSAGES.server],
  ] as const)('status %s -> %s', async (status, body, message) => {
    mockFetch(status, body)
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
  it('network failure is shown, not thrown', async () => {
    mockFetchReject()
    await signIn()
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.network)
  })
})

describe('StaffManagementPanel', () => {
  const staff = [{ id: 4, name: 'Asha', email: 'a@x.in', role: 'crc' as const, mfaEnabled: true }]
  it('shows a failed MFA reset and does not refresh', async () => {
    mockFetch(500, {})
    render(<StaffManagementPanel staff={staff} isAdmin />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset MFA' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
    expect(router.refresh).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Reset MFA' })).toBeEnabled()
  })
  it('shows a failed account creation', async () => {
    mockFetch(409, { error: 'An account with this email already exists' })
    render(<StaffManagementPanel staff={staff} isAdmin />)
    fireEvent.click(screen.getByRole('button', { name: /Add Staff Member/ }))
    const inputs = document.querySelectorAll('form input')
    fireEvent.change(inputs[0], { target: { value: 'New Person' } })
    fireEvent.change(inputs[1], { target: { value: 'n@x.in' } })
    fireEvent.submit(document.querySelector('form')!)
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists')
  })
})

describe('TelemedicineCallScreen', () => {
  class FakePC {
    connectionState = 'new'
    ontrack: unknown = null; onicecandidate: unknown = null; onconnectionstatechange: unknown = null
    addTrack() {}
    async createOffer() { return { type: 'offer', sdp: 'x' } }
    async setLocalDescription() {}
    close() {}
  }
  function setupMedia() {
    vi.stubGlobal('RTCPeerConnection', FakePC)
    const stream = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => stream) } })
  }

  it('shows a failed signal post instead of hanging silently', async () => {
    setupMedia()
    mockFetch(500, {})
    render(<TelemedicineCallScreen role="provider" pollUrl="/api/telemedicine/5/signal" initialStatus="waiting" />)
    expect(await screen.findByRole('alert')).toHaveTextContent(CLIENT_ERROR_MESSAGES.server)
  })

  it('keeps the call up and says so when ending fails', async () => {
    setupMedia()
    const fetchMock = mockFetch(200, { signals: [], sessionStatus: 'in_progress' })
    render(<TelemedicineCallScreen role="provider" pollUrl="/api/telemedicine/5/signal" initialStatus="in_progress" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    mockFetch(500, {})
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /End call/ })) })
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not end the call/)
    expect(screen.queryByText('Call ended')).toBeNull()
    expect(screen.getByRole('button', { name: /End call/ })).toBeEnabled()
  })
})
