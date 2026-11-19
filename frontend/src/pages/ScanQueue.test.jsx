import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import en from '../i18n/en'
import { scanUpload } from '../offline/outbox/ops/scanUpload'
import { SCAN_JOBS_QUERY_KEY, SCAN_QUEUE_QUERY_KEY, refreshScanQueries } from '../utils/scanJobs'

// React Query treats an environment with no window as a server and never schedules refetch intervals.
vi.hoisted(() => { globalThis.window ??= globalThis })

const getScanQueue = vi.fn()
vi.mock('../api/client', () => ({
  deleteScanJob: vi.fn(),
  fetchScanJobItemImageBlob: vi.fn(),
  getScanJob: vi.fn(),
  getScanJobs: vi.fn(),
  getScanQueue: (...args) => getScanQueue(...args),
  resolveAndAddScanJobItem: vi.fn(),
  resolveScanJobItem: vi.fn(),
  retryScanJobItem: vi.fn(),
  waitForScannerJobItem: vi.fn(),
}))
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../components/CardScanner', () => ({ ScanAddModal: () => null }))
vi.mock('../components/ScanReview', () => ({ CardZoomModal: () => null, ScanItemPanel: () => null, useScanItemPhoto: () => null }))
vi.mock('../components/ScanReviewFlow', () => ({ default: () => null, itemKind: () => 'matches' }))
vi.mock('../contexts/ScannerContext', () => ({ useScanner: () => ({ openScanner: () => {} }) }))
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => ({ t: () => '' }) }))
vi.mock('../navigation/useNavBar', () => ({ useNavBar: () => {} }))

const { QueueLoadError, scanQueueQueryOptions } = await import('./ScanQueue')

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key
const empty = { items: [], counts: {} }
const withScan = { items: [{ id: 1 }], counts: { ready: 1 } }

// The app's own defaults (frontend/src/main.jsx): answers stay fresh for 30 s, no refetch on focus.
const newClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: 30000, refetchOnWindowFocus: false, retry: false } } })

let observer
const watch = (client, jobsActive = false) => {
  observer = new QueryObserver(client, scanQueueQueryOptions({ jobsActive }))
  return observer.subscribe(() => {})
}

beforeEach(() => {
  vi.useFakeTimers()
  getScanQueue.mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('refreshScanQueries', () => {
  it('invalidates the queue and the jobs list', () => {
    const queryClient = { invalidateQueries: vi.fn() }
    refreshScanQueries(queryClient)
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: SCAN_QUEUE_QUERY_KEY })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: SCAN_JOBS_QUERY_KEY })
  })

  it('also runs when the outbox finishes sending a queued scan upload', () => {
    const queryClient = { invalidateQueries: vi.fn() }
    scanUpload.onSynced(queryClient, { id: 3 })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: SCAN_QUEUE_QUERY_KEY })
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: SCAN_JOBS_QUERY_KEY })
  })
})

describe('scan queue list refreshing', () => {
  it('polls every 3 s while the jobs list reports scans in progress, and stops when none are', async () => {
    getScanQueue.mockResolvedValue(empty)
    const client = newClient()
    const unsubscribe = watch(client, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(getScanQueue).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getScanQueue).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000)
    expect(getScanQueue).toHaveBeenCalledTimes(3)
    unsubscribe()

    getScanQueue.mockClear()
    const idle = watch(newClient(), false)
    await vi.advanceTimersByTimeAsync(10000)
    expect(getScanQueue).toHaveBeenCalledTimes(1)
    idle()
  })

  it('keeps polling while its own answer says scans are processing', async () => {
    getScanQueue.mockResolvedValue({ items: [{ id: 1 }], counts: { processing: 1 } })
    const unsubscribe = watch(newClient(), false)
    await vi.advanceTimersByTimeAsync(6100)
    expect(getScanQueue).toHaveBeenCalledTimes(3)
    unsubscribe()
  })

  it('replaces a cached empty answer after a submit while staying on /scans', async () => {
    getScanQueue.mockResolvedValue(empty)
    const client = newClient()
    const unsubscribe = watch(client, false)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult().data).toEqual(empty)

    getScanQueue.mockResolvedValue(withScan)
    refreshScanQueries(client) // what startScanning does; the page never remounts
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult().data).toEqual(withScan)
    unsubscribe()
  })

  it('refetches on open even when the cached answer is still fresh', async () => {
    const client = newClient()
    client.setQueryData(SCAN_QUEUE_QUERY_KEY, empty)
    getScanQueue.mockResolvedValue(withScan)
    const unsubscribe = watch(client, false)
    await vi.advanceTimersByTimeAsync(0)
    expect(getScanQueue).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().data).toEqual(withScan)
    unsubscribe()
  })
})

describe('scan queue load error', () => {
  it('has no data and flags an error when the first load fails, and Try again refetches', async () => {
    getScanQueue.mockRejectedValueOnce(new Error('offline'))
    const unsubscribe = watch(newClient(), false)
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult()).toMatchObject({ isError: true, data: undefined })

    getScanQueue.mockResolvedValue(withScan)
    const view = QueueLoadError({ onRetry: () => observer.refetch(), t })
    const [message, button] = view.props.children
    expect(message.props.children).toBe('Your scans could not be loaded.')
    expect(view.props.role).toBe('alert')
    expect(button.props.children).toBe('Try again')
    button.props.onClick()
    await vi.advanceTimersByTimeAsync(0)
    expect(observer.getCurrentResult()).toMatchObject({ isError: false, data: withScan })
    unsubscribe()
  })

  it('keeps the cached list when a later refetch fails', async () => {
    getScanQueue.mockResolvedValueOnce(withScan)
    const client = newClient()
    const unsubscribe = watch(client, false)
    await vi.advanceTimersByTimeAsync(0)
    getScanQueue.mockRejectedValue(new Error('offline'))
    refreshScanQueries(client)
    await vi.advanceTimersByTimeAsync(0)
    const result = observer.getCurrentResult()
    expect(result.isError).toBe(true)
    expect(result.data).toEqual(withScan) // QueueList only shows the error when there is no data
    unsubscribe()
  })
})
