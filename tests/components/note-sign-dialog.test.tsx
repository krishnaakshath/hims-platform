// WS1 T5 (spec ruling 10): signing a note asks for the typed name and the attestation (the
// discharge layout), then PUTs both; NoteForm sends the visit id when it has one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/lib/client-fetch', () => ({ sendJson: vi.fn() }))
import { sendJson } from '@/lib/client-fetch'
import { NoteCard, NoteForm, type NoteRecord } from '@/components/NoteForm'
import { NOTE_ATTESTATION } from '@/lib/encounters/note-signing'

const NOTE: NoteRecord = {
  id: 12, noteType: 'progress', authorName: 'Dr. K', authorRole: 'pi', subjective: 'S', objective: null, assessment: null, plan: null,
  status: 'draft', createdAt: '2026-10-01T05:00:00.000Z', signedAt: null,
}

beforeEach(() => {
  refresh.mockReset()
  vi.mocked(sendJson).mockReset().mockResolvedValue({ ok: true, status: 200, data: { ok: true } })
})

describe('note signing dialog', () => {
  it('needs the typed name and the attestation before it signs', async () => {
    render(<NoteCard note={NOTE} patientId="RD-1" canSign />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }))
    expect(screen.getByRole('dialog', { name: 'Sign note' })).toBeInTheDocument()
    expect(screen.getByText(NOTE_ATTESTATION)).toBeInTheDocument()
    const submit = screen.getByRole('button', { name: 'Sign note' })
    fireEvent.change(screen.getByLabelText('Typed signature'), { target: { value: ' Dr. K ' } })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.click(submit)
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/patients/RD-1/notes/12/sign', 'PUT', { typedName: 'Dr. K', attestation: true }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the refusal in the dialog', async () => {
    vi.mocked(sendJson).mockResolvedValue({ ok: false, status: 403, error: 'You do not have permission to do that.' })
    render(<NoteCard note={NOTE} patientId="RD-1" canSign />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign' }))
    fireEvent.change(screen.getByLabelText('Typed signature'), { target: { value: 'Someone' } })
    fireEvent.click(screen.getByLabelText('Attestation'))
    fireEvent.click(screen.getByRole('button', { name: 'Sign note' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('permission')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('NoteForm links the note to the visit when given an encounterId', async () => {
    vi.mocked(sendJson).mockResolvedValue({ ok: true, status: 201, data: {} })
    render(<NoteForm patientId="RD-1" canWrite encounterId={44} />)
    fireEvent.click(screen.getByRole('button', { name: /new note/i }))
    fireEvent.change(screen.getByLabelText('Subjective'), { target: { value: 'Better' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(sendJson).toHaveBeenCalledWith('/api/patients/RD-1/notes', 'POST', { noteType: 'progress', encounterId: 44, subjective: 'Better' }))
  })
})
