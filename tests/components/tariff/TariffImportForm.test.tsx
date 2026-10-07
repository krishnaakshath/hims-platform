import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { TariffImportForm } from '@/components/tariff/TariffImportForm'
import { SERVICE_CSV_HEADERS, RATE_CSV_HEADERS } from '@/lib/tariff/import'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('TariffImportForm', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  const paste = (text: string) => fireEvent.change(screen.getByLabelText('CSV content'), { target: { value: text } })

  it('keeps Commit disabled until a dry run returns zero issues', async () => {
    fetchMock.mockResolvedValueOnce(json({ kind: 'services', rowCount: 2, issues: [], committed: false }))
    render(<TariffImportForm />)
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
    paste('code,name\nA,B')
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ kind: 'services', csv: 'code,name\nA,B', commit: false })
    expect(screen.getByText(/2 rows? ready to import/i)).toBeInTheDocument()

    // editing the file invalidates the dry run
    paste('code,name\nA,C')
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
  })

  it('renders line-numbered issues and keeps Commit disabled', async () => {
    fetchMock.mockResolvedValueOnce(json({
      kind: 'rates', rowCount: 1, committed: false,
      issues: [{ line: 3, column: 'amount_inr', message: 'Amount must be a number' }, { line: 5, message: '<b>bad</b> overlaps' }],
    }))
    render(<TariffImportForm />)
    fireEvent.click(screen.getByLabelText('Rates'))
    paste('x')
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    const table = await screen.findByRole('table', { name: /import issues/i })
    expect(within(table).getByRole('columnheader', { name: 'Line' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Column' })).toBeInTheDocument()
    expect(within(table).getByRole('columnheader', { name: 'Message' })).toBeInTheDocument()
    expect(within(table).getByText('3')).toBeInTheDocument()
    expect(within(table).getByText('amount_inr')).toBeInTheDocument()
    expect(within(table).getByText('<b>bad</b> overlaps')).toBeInTheDocument() // text, not markup
    expect(table.querySelector('b')).toBeNull()
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
  })

  it('shows the expected headers for the selected kind', () => {
    render(<TariffImportForm />)
    expect(screen.getByText(SERVICE_CSV_HEADERS.join(','))).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Rates'))
    expect(screen.getByText(RATE_CSV_HEADERS.join(','))).toBeInTheDocument()
    expect(screen.queryByText(SERVICE_CSV_HEADERS.join(','))).not.toBeInTheDocument()
  })

  it('commits after a clean dry run and shows the result counts', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ kind: 'services', rowCount: 2, issues: [], committed: false }))
      .mockResolvedValueOnce(json({ kind: 'services', rowCount: 2, issues: [], committed: true, applied: 2 }))
    render(<TariffImportForm />)
    paste('a')
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(await screen.findByText(/imported 2 services/i)).toBeInTheDocument()
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ kind: 'services', csv: 'a', commit: true })
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
    expect(refresh).toHaveBeenCalled()
  })

  it('surfaces a commit conflict (409) in an alert', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ kind: 'rates', rowCount: 1, issues: [], committed: false }))
      .mockResolvedValueOnce(json({ error: 'Import conflicts with existing data; nothing was applied' }, 409))
    render(<TariffImportForm />)
    paste('a')
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Commit' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('nothing was applied')
  })

  it('rejects a file over 1 MB without calling the API', async () => {
    render(<TariffImportForm />)
    const big = new File(['x'], 'big.csv', { type: 'text/csv' })
    Object.defineProperty(big, 'size', { value: 1_000_001 })
    fireEvent.change(screen.getByLabelText('CSV file'), { target: { files: [big] } })
    expect(await screen.findByRole('alert')).toHaveTextContent(/larger than 1 MB/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads a chosen file into the editor and accepts only .csv', async () => {
    render(<TariffImportForm />)
    const input = screen.getByLabelText('CSV file')
    expect(input).toHaveAttribute('accept', expect.stringContaining('.csv'))
    fireEvent.change(input, { target: { files: [new File(['code,name\nA,B'], 'svc.csv', { type: 'text/csv' })] } })
    await waitFor(() => expect(screen.getByLabelText('CSV content')).toHaveValue('code,name\nA,B'))
  })

  it('asks for content before validating', () => {
    render(<TariffImportForm />)
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }))
    expect(screen.getByRole('alert')).toHaveTextContent(/choose a csv file or paste/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
