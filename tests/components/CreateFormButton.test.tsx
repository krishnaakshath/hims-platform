import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CreateFormButton } from '@/components/CreateFormButton'

const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => router }))

afterEach(() => {
  vi.unstubAllGlobals()
  router.push.mockClear()
})

describe('CreateFormButton', () => {
  it('opens /forms/new without creating anything', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CreateFormButton folderId={null} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Create New Form' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(router.push).toHaveBeenCalledWith('/forms/new')
  })

  it('carries the folder into /forms/new', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<CreateFormButton folderId={7} />)
    fireEvent.click(screen.getByRole('button', { name: '+ Create New Form' }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(router.push).toHaveBeenCalledWith('/forms/new?folderId=7')
  })
})
