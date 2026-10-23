import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RxBuilder } from '@/components/encounters/RxBuilder'

afterEach(() => { vi.unstubAllGlobals() })

const AMOX = { id: 7, name: 'Amoxil', genericName: 'Amoxicillin', medicationClass: 'Antibiotic', form: 'capsule', commonDose: '500 mg', inStock: true }
const PARA = { id: 8, name: 'Dolo', genericName: 'Paracetamol', medicationClass: 'Analgesic', form: 'tablet', commonDose: '650 mg', inStock: true }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function setup(props: Partial<React.ComponentProps<typeof RxBuilder>> = {}) {
  const posts: unknown[] = []
  let postResponse: () => Response = () => json(201, { prescriptionId: 5, episodeIds: [11] })
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/medications/search')) {
      const q = new URL(url, 'http://x').searchParams.get('q')!.toLowerCase()
      return json(200, { items: [AMOX, PARA].filter((m) => m.name.toLowerCase().includes(q) || m.genericName.toLowerCase().includes(q)) })
    }
    posts.push(JSON.parse(init!.body as string))
    return postResponse()
  })
  vi.stubGlobal('fetch', fetchMock)
  const onSaved = vi.fn()
  render(<RxBuilder encounterId={3} patientAllergies={[]} allergyStatus="none_known" canWrite onSaved={onSaved} {...props} />)
  return { posts, onSaved, setPost: (f: () => Response) => { postResponse = f } }
}

async function pick(query: string, optionName: RegExp) {
  fireEvent.change(screen.getByLabelText('Drug search'), { target: { value: query } })
  fireEvent.click(await screen.findByRole('option', { name: optionName }))
}
const save = () => screen.getByRole('button', { name: 'Save prescription' })

describe('RxBuilder', () => {
  it('shows the generic under the brand and computes quantity 10 for 1-0-1 x 5 days', async () => {
    setup()
    await pick('amox', /Amoxil/)
    expect(screen.getAllByText('Amoxicillin').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: '1-0-1' }))
    fireEvent.change(screen.getByLabelText('Days'), { target: { value: '5' } })
    expect(screen.getByTestId('rx-quantity')).toHaveTextContent('10')
  })

  it('keeps Save disabled until every row has a dose, then posts once', async () => {
    const { posts, onSaved } = setup()
    expect(save()).toBeDisabled()
    await pick('dolo', /Dolo/)
    fireEvent.click(screen.getByRole('button', { name: '1-0-1' }))
    fireEvent.change(screen.getByLabelText('Dose'), { target: { value: '' } })
    expect(save()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Dose'), { target: { value: '650 mg' } })
    expect(save()).toBeEnabled()
    fireEvent.click(save())
    fireEvent.click(save())
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(5))
    expect(posts).toHaveLength(1)
    expect(posts[0]).toMatchObject({ items: [{ medicationId: 8, name: 'Dolo', dose: '650 mg', dosePattern: '1-0-1', durationDays: 5, route: 'oral' }] })
    expect(screen.getByRole('link', { name: 'Print' })).toHaveAttribute('href', '/prescriptions/print?ids=11')
  })

  it('a penicillin-allergic patient + amoxicillin shows the banner and blocks Save until a reason is typed', async () => {
    const { posts } = setup({ patientAllergies: [{ allergen: 'Penicillin', severity: 'severe' }], allergyStatus: 'recorded' })
    await pick('amox', /Amoxil/)
    fireEvent.click(screen.getByRole('button', { name: '1-0-1' }))
    expect(screen.getByText(/Allergy conflict/)).toBeInTheDocument()
    expect(save()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Allergy override reason'), { target: { value: 'ok' } })
    expect(save()).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Allergy override reason'), { target: { value: 'Tolerated before' } })
    expect(save()).toBeEnabled()
    fireEvent.click(save())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ items: [{ allergyOverrideReason: 'Tolerated before' }] })
  })

  it('maps a server 422 conflict onto the row and does not send a reason on clean rows', async () => {
    const { setPost, posts } = setup()
    setPost(() => json(422, { error: 'conflict', code: 'allergy_conflict', conflicts: [{ index: 0, conflicts: [{ allergen: 'Sulfa', severity: 'moderate', matchedOn: 'class' }] }] }))
    await pick('dolo', /Dolo/)
    fireEvent.click(screen.getByRole('button', { name: '1-0-1' }))
    fireEvent.click(save())
    expect(await screen.findByText(/Sulfa \(moderate\)/)).toBeInTheDocument()
    expect((posts[0] as { items: object[] }).items[0]).not.toHaveProperty('allergyOverrideReason')
    expect(save()).toBeDisabled()
  })

  it('shows an amber banner when allergy status is unknown, and nothing is writable when canWrite is false', () => {
    setup({ allergyStatus: 'unknown' })
    expect(screen.getByText(/Allergy status not recorded/)).toBeInTheDocument()
  })

  it('canWrite=false renders no form', () => {
    setup({ canWrite: false })
    expect(screen.queryByRole('button', { name: 'Save prescription' })).not.toBeInTheDocument()
  })

  it('SOS needs no pattern', async () => {
    const { posts } = setup()
    await pick('dolo', /Dolo/)
    fireEvent.click(screen.getByRole('button', { name: 'SOS' }))
    expect(save()).toBeEnabled()
    expect(screen.getByTestId('rx-quantity')).toHaveTextContent('—')
    fireEvent.click(save())
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({ items: [{ isSos: true }] })
  })

  it('changing the drug after a 422 clears the banner and sends no override reason', async () => {
    const { setPost, posts } = setup()
    setPost(() => json(422, { error: 'conflict', code: 'allergy_conflict', conflicts: [{ index: 0, conflicts: [{ allergen: 'Sulfa', severity: 'moderate', matchedOn: 'class' }] }] }))
    await pick('dolo', /Dolo/)
    fireEvent.click(screen.getByRole('button', { name: '1-0-1' }))
    fireEvent.click(save())
    await screen.findByText(/Sulfa \(moderate\)/)
    fireEvent.change(screen.getByLabelText('Allergy override reason'), { target: { value: 'Some stale reason' } })
    await pick('amox', /Amoxil/)
    expect(screen.queryByText(/Allergy conflict/)).not.toBeInTheDocument()
    expect(save()).toBeEnabled()
    setPost(() => json(201, { prescriptionId: 5, episodeIds: [11] }))
    fireEvent.click(save())
    await waitFor(() => expect(posts).toHaveLength(2))
    expect((posts[1] as { items: object[] }).items[0]).not.toHaveProperty('allergyOverrideReason')
  })
})
