import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IntakePortalForm } from '@/components/IntakePortalForm'
import type { SubmissionConsent } from '@/lib/queries/form-submission-consents'
import type { IntakeQuestion } from '@/components/intake/QuestionField'

const BANNER = '[DRAFT — NOT YET REVIEWED BY LEGAL COUNSEL. DO NOT RELY ON THIS WORDING.]'

function consent(id: number, overrides: Partial<SubmissionConsent> = {}): SubmissionConsent {
  return { formSubmissionConsentId: id, name: `Consent ${id}`, renderedText: `Body of consent ${id}`, signedAt: null, signerTypedName: null, ...overrides }
}

function signOnPage(name: string) {
  fireEvent.change(screen.getByLabelText('Typed signature'), { target: { value: name } })
  fireEvent.click(screen.getByLabelText('Attestation'))
  fireEvent.click(screen.getByRole('button', { name: 'Sign' }))
}

afterEach(() => vi.unstubAllGlobals())

describe('IntakePortalForm consent pages', () => {
  it('consent-only packet: no NaN progress, submit blocked until signed, then posts complete', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<IntakePortalForm token="tok" questions={[]} existingAnswers={{}} autofill={{}} consents={[consent(7)]} />)

    expect(document.body.textContent).not.toContain('NaN')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    expect(screen.getByText('0 of 1 consent signed')).toBeInTheDocument()
    expect(screen.getByText('Body of consent 7')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    expect(screen.getByTestId('submit-blocked-reason')).toHaveTextContent('Please sign the remaining consent document before submitting.')

    signOnPage('Pat Example')
    await waitFor(() => expect(screen.getByText(/^Signed by Pat Example on /)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/intake/tok/consents/7/sign', expect.objectContaining({ method: 'POST', body: JSON.stringify({ typedName: 'Pat Example' }) }))
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(screen.getByText(/your form has been submitted/)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/intake/tok', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ answers: {}, complete: true }) }))
  })

  it('surfaces the sign route error text and keeps the consent unsigned', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'This link is no longer valid.' }), { status: 404 })))
    render(<IntakePortalForm token="tok" questions={[]} existingAnswers={{}} autofill={{}} consents={[consent(7)]} />)
    signOnPage('Pat Example')
    await waitFor(() => expect(screen.getByText('This link is no longer valid.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
  })

  it('questions first, then one page per consent; draft banner shown literally; signed consent read-only', () => {
    render(
      <IntakePortalForm
        token="tok"
        questions={[{ id: 'q1', label: 'Favorite color', type: 'text', hipaaSensitive: false, required: false }]}
        existingAnswers={{}}
        autofill={{}}
        consents={[
          consent(1, { renderedText: `${BANNER}\n\nDraft body <b>not html</b>` }),
          consent(2, { signedAt: new Date('2026-10-01T12:00:00Z'), signerTypedName: 'Pat Example' }),
        ]}
      />,
    )
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    expect(screen.getByText('Favorite color')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument()
    expect(document.body.textContent).toContain(BANNER)
    expect(document.body.textContent).toContain('Draft body <b>not html</b>')
    expect(document.querySelector('b')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText(/^Signed by Pat Example on /)).toBeInTheDocument()
    expect(screen.queryByLabelText('Typed signature')).toBeNull()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    expect(screen.getByTestId('submit-blocked-reason')).toHaveTextContent('Please sign the remaining consent document before submitting.')
  })

  it('no questions and no consents renders no progress bar and no NaN', () => {
    render(<IntakePortalForm token="tok" questions={[]} existingAnswers={{}} autofill={{}} consents={[]} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(document.body.textContent).not.toContain('NaN')
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()
  })
})

// WS7 T3: the v2 renderer -- conditions, languages, file and signature questions, thank-you links.
const COND: IntakeQuestion[] = [
  { id: 'intro', label: 'About you', type: 'section', hipaaSensitive: false, required: false, i18n: { hi: { label: 'आपके बारे में' } } },
  { id: 'smoker', label: 'Do you smoke?', type: 'select', options: ['Yes', 'No'], hipaaSensitive: false, required: true, i18n: { hi: { label: 'क्या आप धूम्रपान करते हैं?', options: ['हाँ', 'नहीं'] } } },
  { id: 'perDay', label: 'Cigarettes per day', type: 'number', min: 1, max: 100, hipaaSensitive: false, required: true, visibleIf: { questionId: 'smoker', equals: 'Yes' } },
]

function okFetch(body: unknown = { ok: true }, status = 200) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('IntakePortalForm v2 renderer (WS7 T3)', () => {
  it('"Yes" reveals the dependent question; "No" hides it, it stops being required and its value is dropped on submit', async () => {
    const fetchMock = okFetch()
    render(<IntakePortalForm token="tok" questions={COND} existingAnswers={{}} autofill={{}} />)
    expect(screen.getByRole('heading', { name: 'About you' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/Cigarettes per day/)).toBeNull()

    fireEvent.change(screen.getByLabelText(/Do you smoke\?/), { target: { value: 'Yes' } })
    const perDay = screen.getByLabelText(/Cigarettes per day/)
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
    fireEvent.change(perDay, { target: { value: '5' } })
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()

    fireEvent.change(screen.getByLabelText(/Do you smoke\?/), { target: { value: 'No' } })
    expect(screen.queryByLabelText(/Cigarettes per day/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(screen.getByText(/your form has been submitted/)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/intake/tok', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ answers: { smoker: 'No' }, complete: true }) }))
  })

  it('the language switch offers only the template\'s languages; Hindi shows Hindi labels and English where untranslated; the stored answer stays English', async () => {
    const fetchMock = okFetch()
    render(<IntakePortalForm token="tok" questions={COND} existingAnswers={{}} autofill={{}} languages={['en', 'hi']} />)
    expect(screen.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'ಕನ್ನಡ' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'हिन्दी' }))
    expect(screen.getByRole('heading', { name: 'आपके बारे में' })).toBeInTheDocument()
    const select = screen.getByLabelText(/क्या आप धूम्रपान करते हैं\?/)
    expect(screen.getByRole('option', { name: 'हाँ' })).toHaveValue('Yes')
    fireEvent.change(select, { target: { value: 'Yes' } })
    expect(screen.getByLabelText(/Cigarettes per day/)).toBeInTheDocument() // untranslated -> English

    fireEvent.change(screen.getByLabelText(/Cigarettes per day/), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/intake/tok', expect.objectContaining({ body: JSON.stringify({ answers: { smoker: 'Yes', perDay: '2' }, complete: true }) }))
  })

  it('no language switch when the template offers English only', () => {
    render(<IntakePortalForm token="tok" questions={COND} existingAnswers={{}} autofill={{}} languages={['en']} />)
    expect(screen.queryByRole('button', { name: 'English' })).toBeNull()
  })

  it('a file question uploads to the intake files route and keeps only the doc:<id> answer', async () => {
    const fetchMock = vi.fn(async (url: unknown) => String(url).endsWith('/files')
      ? new Response(JSON.stringify({ answer: 'doc:42', fileName: 'letter.pdf' }), { status: 201 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const qs: IntakeQuestion[] = [
      { id: 'scan', label: 'Referral letter', type: 'file', hipaaSensitive: false, required: true },
      { id: 'sign', label: 'Your signature', type: 'signature', hipaaSensitive: false, required: true },
    ]
    render(<IntakePortalForm token="tok" questions={qs} existingAnswers={{}} autofill={{}} />)
    fireEvent.change(screen.getByLabelText(/Referral letter/), { target: { files: [new File(['%PDF-1.4'], 'letter.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(screen.getByText(/letter\.pdf/)).toBeInTheDocument())
    expect(fetchMock.mock.calls[0][0]).toBe('/api/intake/tok/files')

    fireEvent.change(screen.getByLabelText(/Your signature/), { target: { value: 'Maria Alvarez' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(screen.getByText(/your form has been submitted/)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/intake/tok', expect.objectContaining({ body: JSON.stringify({ answers: { scan: 'doc:42', sign: 'Maria Alvarez' }, complete: true }) }))
  })

  it('a rejected upload shows the route\'s message and leaves the question unanswered', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Files must be 5 MB or smaller.' }), { status: 413 })))
    render(<IntakePortalForm token="tok" questions={[{ id: 'scan', label: 'Referral letter', type: 'file', hipaaSensitive: false, required: true }]} existingAnswers={{}} autofill={{}} />)
    fireEvent.change(screen.getByLabelText(/Referral letter/), { target: { files: [new File(['x'], 'big.pdf', { type: 'application/pdf' })] } })
    await waitFor(() => expect(screen.getByText('Files must be 5 MB or smaller.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled()
  })

  it('thank-you offers the portal back-link and the signed copy (in the language used) only when portal-linked', async () => {
    okFetch()
    const { unmount } = render(<IntakePortalForm token="tok" questions={[]} existingAnswers={{}} autofill={{}} languages={['en', 'hi']} signedCopyHref="/patient-portal/documents/forms/9" />)
    fireEvent.click(screen.getByRole('button', { name: 'हिन्दी' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(screen.getByText(/your form has been submitted/)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Back to your portal' })).toHaveAttribute('href', '/patient-portal')
    expect(screen.getByRole('link', { name: 'View signed copy' })).toHaveAttribute('href', '/patient-portal/documents/forms/9?lang=hi')
    unmount()

    render(<IntakePortalForm token="tok" questions={[]} existingAnswers={{}} autofill={{}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(screen.getByText(/your form has been submitted/)).toBeInTheDocument())
    expect(screen.queryByRole('link', { name: 'Back to your portal' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'View signed copy' })).toBeNull()
  })
})
