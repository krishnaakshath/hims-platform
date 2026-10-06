import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FormBuilderEditor } from '@/components/FormBuilderEditor'
import type { AttachedConsentRow } from '@/lib/queries/form-template-consents'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

afterEach(() => {
  vi.unstubAllGlobals()
})

const BASE_PROPS = {
  templateId: 1,
  initialName: 'Depression Screening',
  initialCategory: 'Screening Questionnaires',
  initialDiagnosisTag: 'Major Depressive Disorder',
  initialFolderId: null as number | null,
  initialIsActive: true,
  folders: [{ id: 7, name: 'Research Forms' }],
  attachedConsents: [] as AttachedConsentRow[],
  allConsentDocuments: [{ id: 1, name: 'HIPAA Notice' }],
  patients: [],
}

describe('FormBuilderEditor', () => {
  it('does not show an options editor for a text question', () => {
    render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={[{ id: 'q1', label: 'Full name', type: 'text', hipaaSensitive: false, required: true }]} />)
    expect(screen.queryByText('Options')).not.toBeInTheDocument()
  })

  it('shows an options editor with add/remove for a select question', () => {
    render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate'], hipaaSensitive: false, required: true }]} />)

    expect(screen.getByText('Options')).toBeInTheDocument()
    expect(screen.getByLabelText('Option 1 for Severity')).toHaveValue('Mild')
    expect(screen.getByLabelText('Option 2 for Severity')).toHaveValue('Moderate')

    fireEvent.click(screen.getByText('+ Add option'))
    expect(screen.getByLabelText('Option 3 for Severity')).toHaveValue('')

    fireEvent.change(screen.getByLabelText('Option 3 for Severity'), { target: { value: 'Severe' } })
    expect(screen.getByLabelText('Option 3 for Severity')).toHaveValue('Severe')

    fireEvent.click(screen.getAllByLabelText('Remove option')[0])
    expect(screen.queryByDisplayValue('Mild')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Option 1 for Severity')).toHaveValue('Moderate')
  })

  it('reveals an empty options editor immediately when switching a question to Select', () => {
    render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={[{ id: 'q1', label: 'Notes', type: 'text', hipaaSensitive: false, required: false }]} />)
    fireEvent.change(screen.getByDisplayValue('Text'), { target: { value: 'select' } })
    expect(screen.getByText('No options yet — add at least one so patients have something to choose.')).toBeInTheDocument()
  })

  it('strips blank option rows before saving', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', ''], hipaaSensitive: false, required: true }]} />)
    fireEvent.click(screen.getByText('Save Form'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init!.body as string)
    expect(body.questions[0].options).toEqual(['Mild'])
  })

  // Final review I3: optionScores must stay in lockstep with options through
  // add/remove/move, or point values silently attach to the wrong answer
  // choice on a scored template (e.g. PHQ-9/GAD-7).
  describe('keeps optionScores in lockstep with options (final review I3)', () => {
    it('pads a new option with null in optionScores, not a real 0', async () => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate'], optionScores: [0, 5], hipaaSensitive: false, required: true }]} />)
      fireEvent.click(screen.getByText('+ Add option'))
      fireEvent.change(screen.getByLabelText('Option 3 for Severity'), { target: { value: 'Severe' } })
      fireEvent.click(screen.getByText('Save Form'))

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(init!.body as string)
      expect(body.questions[0].options).toEqual(['Mild', 'Moderate', 'Severe'])
      expect(body.questions[0].optionScores).toEqual([0, 5, null])
    })

    it('splices the matching index out of optionScores when an option is removed', async () => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate', 'Severe'], optionScores: [0, 5, 10], hipaaSensitive: false, required: true }]} />)
      fireEvent.click(screen.getAllByLabelText('Remove option')[0]) // removes 'Mild'
      fireEvent.click(screen.getByText('Save Form'))

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(init!.body as string)
      expect(body.questions[0].options).toEqual(['Moderate', 'Severe'])
      expect(body.questions[0].optionScores).toEqual([5, 10])
    })

    it('swaps the matching index in optionScores when an option is moved', async () => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)

      render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate'], optionScores: [0, 5], hipaaSensitive: false, required: true }]} />)
      fireEvent.click(screen.getAllByLabelText('Move option down')[0]) // swaps Mild/Moderate
      fireEvent.click(screen.getByText('Save Form'))

      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, init] = fetchMock.mock.calls[0]
      const body = JSON.parse(init!.body as string)
      expect(body.questions[0].options).toEqual(['Moderate', 'Mild'])
      expect(body.questions[0].optionScores).toEqual([5, 0])
    })
  })

  describe('editor frame', () => {
    const Q = [{ id: 'q1', label: 'Full name', type: 'text' as const, hipaaSensitive: false, required: true }]
    const ATTACHED: AttachedConsentRow[] = [{ formTemplateConsentId: 1, consentDocumentId: 1, name: 'HIPAA Notice', bodyPreview: 'We protect', legalReviewStatus: 'draft', sortOrder: 0, signedCount: 3 }]

    it('renders the toolbar controls in order', () => {
      render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={Q} />)
      const labels = ['Send to Client', 'Preview', 'Consent Forms', 'Add New Question']
      const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim())
      const positions = labels.map((l) => buttons.indexOf(l))
      expect(positions.every((p) => p >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    })

    it('reads Unsaved changes after an edit, with no fetch and an explicit Save', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={Q} />)
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Saved/))
      fireEvent.change(screen.getByDisplayValue('Full name'), { target: { value: 'Legal name' } })
      expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
      expect(screen.getByText('Save Form')).toBeInTheDocument()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns to Saved after a successful save and sends folderId', async () => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={Q} />)
      fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '7' } })
      expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
      fireEvent.click(screen.getByText('Save Form'))
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Saved/))
      expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).folderId).toBe(7)
    })

    it('renders a Folder select seeded to initialFolderId with an un-filed option', () => {
      render(<FormBuilderEditor {...BASE_PROPS} initialFolderId={7} initialQuestions={Q} />)
      const select = screen.getByLabelText('Folder') as HTMLSelectElement
      expect(select.value).toBe('7')
      expect(screen.getByRole('option', { name: '— No folder —' })).toBeInTheDocument()
    })

    it('swaps between the question list and the consents view', () => {
      render(<FormBuilderEditor {...BASE_PROPS} attachedConsents={ATTACHED} initialQuestions={Q} />)
      expect(screen.getByDisplayValue('Full name')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Consent Forms' }))
      expect(screen.queryByDisplayValue('Full name')).not.toBeInTheDocument()
      expect(screen.getByText('HIPAA Notice', { selector: 'p' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Consent Forms' }))
      expect(screen.getByDisplayValue('Full name')).toBeInTheDocument()
    })

    it('shows name, review status, signed count and Detach for attached consents', () => {
      render(<FormBuilderEditor {...BASE_PROPS} attachedConsents={ATTACHED} initialQuestions={Q} />)
      fireEvent.click(screen.getByRole('button', { name: 'Consent Forms' }))
      expect(screen.getByText('HIPAA Notice', { selector: 'p' })).toBeInTheDocument()
      expect(screen.getByText('draft')).toBeInTheDocument()
      expect(screen.getByText('3 signed')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Detach' })).toBeInTheDocument()
    })

    it('shows the info panel with counts and the five static items', () => {
      render(<FormBuilderEditor {...BASE_PROPS} attachedConsents={ATTACHED} initialQuestions={Q} />)
      const panel = screen.getByRole('complementary')
      expect(panel).toHaveTextContent('Depression Screening')
      expect(panel).toHaveTextContent('1 question')
      expect(panel).toHaveTextContent('1 attached consent')
      expect(panel).toHaveTextContent('Common things you can do here')
      expect(panel.querySelectorAll('li')).toHaveLength(5)
    })

    it('disables Archive while there are unsaved changes', () => {
      render(<FormBuilderEditor {...BASE_PROPS} initialQuestions={Q} />)
      expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled()
      fireEvent.change(screen.getByDisplayValue('Full name'), { target: { value: 'X' } })
      expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
      expect(screen.getByText('Save your changes before archiving.')).toBeInTheDocument()
    })

    it('hides Archive for an already archived template', () => {
      render(<FormBuilderEditor {...BASE_PROPS} initialIsActive={false} initialQuestions={Q} />)
      expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    })
  })
})
