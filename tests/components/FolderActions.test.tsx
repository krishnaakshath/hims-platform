import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { FolderActions } from '@/components/FolderActions'
import { NewFolderButton } from '@/components/NewFolderButton'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('FolderActions network failure', () => {
  it('shows an error and re-enables Save when rename fetch rejects', async () => {
    render(<FolderActions folder={{ id: 1, name: 'Intake' }} templateCount={2} />)
    fireEvent.click(screen.getByRole('button', { name: /rename/i }))
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/could not rename folder/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled()
  })

  it('shows an error and re-enables Delete when delete fetch rejects', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<FolderActions folder={{ id: 1, name: 'Intake' }} templateCount={2} />)
    fireEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(await screen.findByText(/could not delete folder/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: /delete/i })).not.toBeDisabled())
  })
})

describe('NewFolderButton network failure', () => {
  it('shows an error and re-enables Create when the fetch rejects', async () => {
    render(<NewFolderButton />)
    fireEvent.click(screen.getByRole('button', { name: /new folder/i }))
    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Billing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    expect(await screen.findByText(/could not create folder/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled()
  })
})
