import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))
import { ReadinessPanel } from '@/components/rcm/ReadinessPanel'

describe('ReadinessPanel', () => {
  it('lists blocks before warnings and offers Upload and Waive for a missing document', () => {
    render(<ReadinessPanel claimId={4} ready={false} editable items={[
      { code: 'hospital_ids_missing', severity: 'warn', message: 'Set the hospital ROHINI ID in RCM settings' },
      { code: 'document_missing', severity: 'block', message: 'Missing document: Claim form', documentKind: 'claim_form' },
      { code: 'document_missing', severity: 'block', message: 'Missing document: Photo ID proof', documentKind: 'id_proof' },
    ]} />)
    const items = screen.getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-severity'))).toEqual(['block', 'block', 'warn'])
    expect(within(items[0]).getByLabelText('Upload Missing document: Claim form')).toBeInTheDocument()
    expect(within(items[0]).getByRole('button', { name: 'Waive' })).toBeInTheDocument()
    expect(within(items[1]).getByRole('link', { name: /Upload in Documents/ })).toHaveAttribute('href', '#documents')
    expect(screen.getByRole('heading', { name: 'Not ready to submit' })).toBeInTheDocument()
  })
  it('a read-only claim shows no actions', () => {
    render(<ReadinessPanel claimId={4} ready={false} editable={false} items={[{ code: 'document_missing', severity: 'block', message: 'Missing document: Claim form', documentKind: 'claim_form' }]} />)
    expect(screen.queryByRole('button', { name: 'Waive' })).not.toBeInTheDocument()
  })
})
