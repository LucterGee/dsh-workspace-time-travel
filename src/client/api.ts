/**
 * Browser client for the host /tt/* routes: typed JSON envelope calls.
 * Same-origin relative fetch (the page and the routes share the webserver).
 * @module dsh-workspace-time-travel/client/api
 */

export interface TtError {
  code: string
  message: string
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: TtError }

export interface SnapshotMeta {
  found: boolean
  key?: number
  createdAt?: number
  fileCount?: number
}

export interface PreviewResult {
  changes: { op: 'restore' | 'delete'; path: string; size: number }[]
  total: number
  truncated: boolean
}

export interface RestoreResult {
  applied: number
  skipped: number
  changes: number
  backupId: string
}

export interface UndoResult {
  applied: number
  skipped: number
  changes: number
}

const TRANSPORT_ERROR: TtError = { code: 'internal', message: 'route unavailable' }

/** POST one JSON payload and decode the envelope; never throws. */
async function post<T>(path: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
  try {
    const envelope = await response.json() as unknown
    if (typeof envelope !== 'object' || envelope === null) return { ok: false, error: TRANSPORT_ERROR }
    const record = envelope as Record<string, unknown>
    if (record.ok === true) return { ok: true, value: record.value as T }
    return { ok: false, error: record.error as TtError }
  } catch {
    return { ok: false, error: TRANSPORT_ERROR }
  }
}

export class TtApi {
  snapshot(payload: { path: string; sessionId: string; atSeq: number }): Promise<ApiResult<SnapshotMeta>> {
    return post('/tt/snapshot', payload)
  }

  preview(payload: { path: string; sessionId: string; atSeq: number }): Promise<ApiResult<PreviewResult>> {
    return post('/tt/preview', payload)
  }

  restore(payload: { path: string; sessionId: string; atSeq: number }): Promise<ApiResult<RestoreResult>> {
    return post('/tt/restore', payload)
  }

  undo(payload: { path: string; sessionId: string }): Promise<ApiResult<UndoResult>> {
    return post('/tt/undo', payload)
  }
}
