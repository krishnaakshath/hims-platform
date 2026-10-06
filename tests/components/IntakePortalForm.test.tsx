import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IntakePortalForm } from '@/components/IntakePortalForm'
import type { SubmissionConsent } from '@/lib/queries/form-submission-consents'

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
        questions={[{ id: 'q1', label: 'Favorite color', type: 'text', required: false }]}
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
