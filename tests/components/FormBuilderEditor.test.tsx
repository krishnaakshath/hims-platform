import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FormBuilderEditor } from '@/components/FormBuilderEditor'
import type { AttachedConsentRow } from '@/lib/queries/form-template-consents'
import type { FormLang, FormQuestion } from '@/lib/forms/question-model'

const router = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

afterEach(() => {
  vi.unstubAllGlobals()
  router.refresh.mockClear(); router.push.mockClear(); router.replace.mockClear()
})

const INITIAL = {
  name: 'Depression Screening',
  category: 'Screening Questionnaires',
  diagnosisTag: 'Major Depressive Disorder',
  folderId: null as number | null,
  languages: ['en'] as FormLang[],
}

const BASE_PROPS = {
  templateId: 1 as number | null,
  initialIsActive: true,
  folders: [{ id: 7, name: 'Research Forms' }],
  attachedConsents: [] as AttachedConsentRow[],
  allConsentDocuments: [{ id: 1, name: 'HIPAA Notice' }],
  patients: [],
}

// The editor under its pre-T2 call shape, so the older cases stay readable.
function Editor({ initialQuestions, initialFolderId = null, languages = ['en'], ...rest }: Partial<typeof BASE_PROPS> & {
  initialQuestions: FormQuestion[]
  initialFolderId?: number | null
  languages?: FormLang[]
}) {
  return <FormBuilderEditor {...BASE_PROPS} {...rest} initial={{ ...INITIAL, folderId: initialFolderId, languages, questions: initialQuestions }} />
}

describe('FormBuilderEditor', () => {
  it('does not show an options editor for a text question', () => {
    render(<Editor initialQuestions={[{ id: 'q1', label: 'Full name', type: 'text', hipaaSensitive: false, required: true }]} />)
    expect(screen.queryByText('Options')).not.toBeInTheDocument()
  })

  it('shows an options editor with add/remove for a select question', () => {
    render(<Editor initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate'], hipaaSensitive: false, required: true }]} />)

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
    render(<Editor initialQuestions={[{ id: 'q1', label: 'Notes', type: 'text', hipaaSensitive: false, required: false }]} />)
    fireEvent.change(screen.getByDisplayValue('Text'), { target: { value: 'select' } })
    expect(screen.getByText('No options yet — add at least one so patients have something to choose.')).toBeInTheDocument()
  })

  it('strips blank option rows before saving', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(<Editor initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', ''], hipaaSensitive: false, required: true }]} />)
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

      render(<Editor initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate'], optionScores: [0, 5], hipaaSensitive: false, required: true }]} />)
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

      render(<Editor initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate', 'Severe'], optionScores: [0, 5, 10], hipaaSensitive: false, required: true }]} />)
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

      render(<Editor initialQuestions={[{ id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate'], optionScores: [0, 5], hipaaSensitive: false, required: true }]} />)
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
      render(<Editor initialQuestions={Q} />)
      const labels = ['Send to Client', 'Preview', 'Consent Forms', 'Add New Question']
      const buttons = screen.getAllByRole('button').map((b) => b.textContent?.trim())
      const positions = labels.map((l) => buttons.indexOf(l))
      expect(positions.every((p) => p >= 0)).toBe(true)
      expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    })

    it('reads Unsaved changes after an edit, with no fetch and an explicit Save', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor initialQuestions={Q} />)
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Saved/))
      fireEvent.change(screen.getByDisplayValue('Full name'), { target: { value: 'Legal name' } })
      expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
      expect(screen.getByText('Save Form')).toBeInTheDocument()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('returns to Saved after a successful save and sends folderId', async () => {
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor initialQuestions={Q} />)
      fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '7' } })
      expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes')
      fireEvent.click(screen.getByText('Save Form'))
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/^Saved/))
      expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string).folderId).toBe(7)
    })

    it('renders a Folder select seeded to initialFolderId with an un-filed option', () => {
      render(<Editor initialFolderId={7} initialQuestions={Q} />)
      const select = screen.getByLabelText('Folder') as HTMLSelectElement
      expect(select.value).toBe('7')
      expect(screen.getByRole('option', { name: '— No folder —' })).toBeInTheDocument()
    })

    it('swaps between the question list and the consents view', () => {
      render(<Editor attachedConsents={ATTACHED} initialQuestions={Q} />)
      expect(screen.getByDisplayValue('Full name')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Consent Forms' }))
      expect(screen.queryByDisplayValue('Full name')).not.toBeInTheDocument()
      expect(screen.getByText('HIPAA Notice', { selector: 'p' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Consent Forms' }))
      expect(screen.getByDisplayValue('Full name')).toBeInTheDocument()
    })

    it('shows name, review status, signed count and Detach for attached consents', () => {
      render(<Editor attachedConsents={ATTACHED} initialQuestions={Q} />)
      fireEvent.click(screen.getByRole('button', { name: 'Consent Forms' }))
      expect(screen.getByText('HIPAA Notice', { selector: 'p' })).toBeInTheDocument()
      expect(screen.getByText('draft')).toBeInTheDocument()
      expect(screen.getByText('3 signed')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Detach' })).toBeInTheDocument()
    })

    it('shows the info panel with counts and the five static items', () => {
      render(<Editor attachedConsents={ATTACHED} initialQuestions={Q} />)
      const panel = screen.getByRole('complementary')
      expect(panel).toHaveTextContent('Depression Screening')
      expect(panel).toHaveTextContent('1 question')
      expect(panel).toHaveTextContent('1 attached consent')
      expect(panel).toHaveTextContent('Common things you can do here')
      expect(panel.querySelectorAll('li')).toHaveLength(5)
    })

    it('disables Archive while there are unsaved changes', () => {
      render(<Editor initialQuestions={Q} />)
      expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled()
      fireEvent.change(screen.getByDisplayValue('Full name'), { target: { value: 'X' } })
      expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled()
      expect(screen.getByText('Save your changes before archiving.')).toBeInTheDocument()
    })

    it('hides Archive for an already archived template', () => {
      render(<Editor initialIsActive={false} initialQuestions={Q} />)
      expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    })
  })

  describe('WS7 T2: new forms, types, sections, conditions, translations', () => {
    type FetchFn = (url: string, init?: RequestInit) => Promise<Response>
    const okCreate = () => vi.fn<FetchFn>(async () => new Response(JSON.stringify({ id: 42 }), { status: 201 }))
    const okSave = () => vi.fn<FetchFn>(async () => new Response('{}', { status: 200 }))

    it('creates no template while /forms/new is left untouched', async () => {
      const fetchMock = okCreate()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor templateId={null} initialQuestions={[]} />)
      await new Promise((r) => setTimeout(r, 900))
      expect(fetchMock).not.toHaveBeenCalled()
      expect(router.replace).not.toHaveBeenCalled()
    })

    it('typing a title sends exactly one POST and replaces the URL with the new template', async () => {
      const fetchMock = okCreate()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor templateId={null} initialFolderId={7} initialQuestions={[]} />)
      const title = screen.getByLabelText('Form name')
      for (const value of ['P', 'PH', 'PHQ', 'PHQ-9']) fireEvent.change(title, { target: { value } })
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/forms/42'), { timeout: 2000 })
      await new Promise((r) => setTimeout(r, 700))
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('/api/form-templates')
      expect(init!.method).toBe('POST')
      const body = JSON.parse(init!.body as string)
      expect(body).toMatchObject({ name: 'PHQ-9', folderId: 7, questions: [], languages: ['en'] })
      expect(body.category.length).toBeGreaterThan(0)
      expect(body.diagnosisTag.length).toBeGreaterThan(0)
    })

    it('offers all ten question types', () => {
      render(<Editor initialQuestions={[{ id: 'q1', label: 'Full name', type: 'text', hipaaSensitive: false, required: true }]} />)
      const typeSelect = screen.getByDisplayValue('Text') as HTMLSelectElement
      expect([...typeSelect.options].map((o) => o.value)).toEqual(
        ['text', 'textarea', 'date', 'select', 'checkbox', 'number', 'phone', 'file', 'signature', 'section'])
    })

    it('adds a section that renders as a heading and can be reordered', () => {
      render(<Editor initialQuestions={[{ id: 'q1', label: 'Full name', type: 'text', hipaaSensitive: false, required: true }]} />)
      fireEvent.click(screen.getByRole('button', { name: 'Add Section' }))
      const heading = screen.getByLabelText('Section heading')
      expect(heading).toHaveValue('New section')
      fireEvent.change(heading, { target: { value: 'About you' } })
      // The section is last; move it above the question.
      const rows = () => screen.getAllByTestId('builder-row').map((r) => r.getAttribute('data-kind'))
      expect(rows()).toEqual(['question', 'section'])
      fireEvent.click(screen.getAllByLabelText('Move up')[1])
      expect(rows()).toEqual(['section', 'question'])
      expect(screen.getByLabelText('Section heading')).toHaveValue('About you')
      // A section is not a question: no Required / PHI toggles, and it is not counted.
      expect(screen.getAllByLabelText('Required')).toHaveLength(1)
      expect(screen.getByRole('complementary')).toHaveTextContent('1 question')
    })

    it('saves a section as required: false and drops min/max when a number becomes text', async () => {
      const fetchMock = okSave()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor initialQuestions={[
        { id: 'q1', label: 'Age', type: 'number', min: 0, max: 120, hipaaSensitive: false, required: true },
        { id: 's1', label: 'Old', type: 'text', hipaaSensitive: false, required: true },
      ]} />)
      expect(screen.getByLabelText('Minimum')).toHaveValue(0)
      expect(screen.getByLabelText('Maximum')).toHaveValue(120)
      const [ageType, oldType] = screen.getAllByLabelText('Question type')
      fireEvent.change(ageType, { target: { value: 'text' } })
      fireEvent.change(oldType, { target: { value: 'section' } })
      fireEvent.click(screen.getByText('Save Form'))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
      expect(body.questions[0]).not.toHaveProperty('min')
      expect(body.questions[0]).not.toHaveProperty('max')
      expect(body.questions[1]).toMatchObject({ type: 'section', required: false })
    })

    it('adds "Show only if Q2 = Yes" and saves it as visibleIf', async () => {
      const fetchMock = okSave()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor initialQuestions={[
        { id: 'q1', label: 'Full name', type: 'text', hipaaSensitive: false, required: true },
        { id: 'q2', label: 'Any allergies?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: false, required: true },
        { id: 'q3', label: 'Which allergies?', type: 'textarea', hipaaSensitive: false, required: false },
      ]} />)
      const buttons = screen.getAllByRole('button', { name: 'Show only if…' })
      fireEvent.click(buttons[buttons.length - 1])
      const trigger = screen.getByLabelText('Show only if question') as HTMLSelectElement
      expect([...trigger.options].map((o) => o.textContent)).toEqual(['Q2. Any allergies?'])
      fireEvent.change(screen.getByLabelText('Show only if answer'), { target: { value: 'Yes' } })
      fireEvent.click(screen.getByText('Save Form'))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
      expect(body.questions[2].visibleIf).toEqual({ questionId: 'q2', equals: 'Yes' })
    })

    it('drops a condition whose trigger is moved below it', async () => {
      const fetchMock = okSave()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor initialQuestions={[
        { id: 'q1', label: 'Smoker?', type: 'checkbox', hipaaSensitive: false, required: false },
        { id: 'q2', label: 'Packs a day', type: 'number', hipaaSensitive: false, required: false, visibleIf: { questionId: 'q1', equals: 'true' } },
      ]} />)
      fireEvent.click(screen.getAllByLabelText('Move down')[0])
      fireEvent.click(screen.getByText('Save Form'))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
      expect(body.questions.map((q: FormQuestion) => q.id)).toEqual(['q2', 'q1'])
      expect(body.questions[0].visibleIf ?? null).toBeNull()
    })

    it('shows Hindi inputs with the English text as placeholder and counts translated labels', async () => {
      const fetchMock = okSave()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor initialQuestions={[
        { id: 'q1', label: 'Full name', type: 'text', hipaaSensitive: false, required: true },
        { id: 'q2', label: 'Any allergies?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: false, required: true, i18n: { hi: { label: 'कोई एलर्जी?' } } },
      ]} />)
      fireEvent.click(screen.getByRole('button', { name: 'Translations' }))
      expect(screen.getByText('Hindi 1/2 labels')).toBeInTheDocument()
      expect(screen.getByText('Kannada 0/2 labels')).toBeInTheDocument()
      fireEvent.change(screen.getByPlaceholderText('Full name'), { target: { value: 'पूरा नाम' } })
      expect(screen.getByText('Hindi 2/2 labels')).toBeInTheDocument()
      fireEvent.change(screen.getByPlaceholderText('Yes'), { target: { value: 'हाँ' } })
      fireEvent.click(screen.getByLabelText('Offer this form in Hindi'))
      fireEvent.click(screen.getByText('Save Form'))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
      expect(body.languages).toEqual(['en', 'hi'])
      expect(body.questions[0].i18n).toEqual({ hi: { label: 'पूरा नाम' } })
      // Translated options stay one for one with the English options.
      expect(body.questions[1].i18n).toEqual({ hi: { label: 'कोई एलर्जी?', options: ['हाँ', ''] } })
    })

    it('keeps translated options in lockstep when an English option is removed', async () => {
      const fetchMock = okSave()
      vi.stubGlobal('fetch', fetchMock)
      render(<Editor initialQuestions={[
        { id: 'q1', label: 'Severity', type: 'select', options: ['Mild', 'Moderate', 'Severe'], hipaaSensitive: false, required: true, i18n: { hi: { options: ['हल्का', 'मध्यम', 'गंभीर'] } } },
      ]} />)
      fireEvent.click(screen.getAllByLabelText('Remove option')[0])
      fireEvent.click(screen.getByText('Save Form'))
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
      expect(body.questions[0].i18n.hi.options).toEqual(['मध्यम', 'गंभीर'])
    })
  })
})
