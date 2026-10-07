import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { RoomCategoriesPanel } from '@/components/tariff/RoomCategoriesPanel'

const refresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const categories = [
  { id: 1, code: 'GENERAL', name: 'General Ward', isActive: true },
  { id: 2, code: 'ICU', name: 'Intensive Care', isActive: true },
  { id: 3, code: 'OLD', name: 'Retired', isActive: false },
]
const rooms = [
  { id: 10, ward: 'Ward A', roomNumber: '101', bedNumber: '1', roomCategoryId: 1 },
  { id: 11, ward: 'Ward A', roomNumber: '102', bedNumber: '1', roomCategoryId: null },
  { id: 12, ward: 'ICU Ward', roomNumber: '1', bedNumber: '1', roomCategoryId: null },
]

describe('RoomCategoriesPanel', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    refresh.mockClear()
    fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('PUTs the chosen category for a room and null for "None"', async () => {
    render(<RoomCategoriesPanel categories={categories} rooms={rooms} />)
    fireEvent.change(screen.getByLabelText('Category for Ward A room 102 bed 1'), { target: { value: '2' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tariff/rooms/11/category')
    expect(fetchMock.mock.calls[0][1].method).toBe('PUT')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ roomCategoryId: 2 })

    fireEvent.change(screen.getByLabelText('Category for Ward A room 101 bed 1'), { target: { value: '' } })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ roomCategoryId: null })
  })

  it('groups rooms by ward and does not offer inactive categories', () => {
    render(<RoomCategoriesPanel categories={categories} rooms={rooms} />)
    expect(screen.getByRole('heading', { name: 'Ward A' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'ICU Ward' })).toBeInTheDocument()
    const select = screen.getByLabelText('Category for Ward A room 102 bed 1')
    expect(within(select).queryByRole('option', { name: /Retired/ })).not.toBeInTheDocument()
    expect(within(select).getByRole('option', { name: 'None' })).toBeInTheDocument()
  })

  it('shows the server error when a room assignment fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Room category not found or inactive' }), { status: 400 }))
    render(<RoomCategoriesPanel categories={categories} rooms={rooms} />)
    fireEvent.change(screen.getByLabelText('Category for Ward A room 102 bed 1'), { target: { value: '2' } })
    expect(await screen.findByRole('alert')).toHaveTextContent('Room category not found or inactive')
  })

  it('creates a category, validating the code client-side', async () => {
    render(<RoomCategoriesPanel categories={categories} rooms={rooms} />)
    fireEvent.change(screen.getByLabelText('New category code'), { target: { value: '1x' } })
    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'Deluxe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/start with a letter/i)
    expect(fetchMock).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('New category code'), { target: { value: 'deluxe' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add category' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tariff/room-categories')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ code: 'DELUXE', name: 'Deluxe' })
  })

  it('renames a category and (after confirmation) deactivates one', async () => {
    render(<RoomCategoriesPanel categories={categories} rooms={rooms} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename ICU' }))
    fireEvent.change(screen.getByLabelText('Name for ICU'), { target: { value: 'Critical Care' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save name for ICU' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toBe('/api/tariff/room-categories/2')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ name: 'Critical Care' })

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate ICU' }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate category' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ isActive: false })

    fireEvent.click(screen.getByRole('button', { name: 'Activate OLD' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ isActive: true })
  })

  it('shows empty states', () => {
    render(<RoomCategoriesPanel categories={[]} rooms={[]} />)
    expect(screen.getByText(/no room categories yet/i)).toBeInTheDocument()
    expect(screen.getByText(/no rooms/i)).toBeInTheDocument()
  })
})
