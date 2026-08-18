/**
 * dsh-workspace-time-travel — browser half.
 *
 * UX: a small "回退" button appended to every completed turn's action row
 * (the 'conversation.chat.turnTail' slot — right beside the built-in branch
 * button). Clicking it offers three choices:
 *   1. 恢复代码和对话 — restore workspace files to the snapshot taken after
 *      this turn, then fork the conversation at this position (switch to the
 *      new branch).
 *   2. 恢复对话 — fork the conversation only (same as the built-in branch
 *      button); files stay untouched.
 *   3. 恢复代码 — restore workspace files only; the conversation continues.
 * Restores show a diff preview first and are backed up automatically
 * (undoable).
 *
 * @module dsh-workspace-time-travel/client
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComposedProps, OwnerOf, SessionIdOf } from '@deepseek-ai/dsh-client-ui-slots'
import { TtApi, type ApiResult, type SnapshotMeta } from './api.js'
import { TT_CSS } from './styles.js'

// ---------------------------------------------------------------- css

let stylesInjected = false
function injectStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-workspace-time-travel'
  tag.textContent = TT_CSS
  document.head.appendChild(tag)
}

// ------------------------------------------------------------ helpers

function timeOf(ms: number | undefined): string {
  if (ms === undefined) return ''
  try { return new Date(ms).toLocaleTimeString() } catch { return '' }
}

function errorMessage(env: ApiResult<unknown> | null): string {
  if (env && !env.ok && env.error.message) return env.error.message
  return '操作失败'
}

/** Per (session, seq) memo of the snapshot existence check. */
const snapshotCache = new Map<string, { phase: 'ready'; meta: SnapshotMeta } | { phase: 'none' }>()

/** The registrant's business face, injected into the turn-tail entry. */
export interface TtInjected {
  api: TtApi
  /** The session the entry mounts under (inject-factory param), with a live fallback. */
  sessionId: SessionId | undefined
  currentSessionId: () => SessionId | undefined
  cwdOf: (sessionId: SessionId | undefined) => string | undefined
  forkConversation: (sessionId: SessionId, atSeq: number) => Promise<void>
}

/** Owner share of the turn-tail slot, derived from the conversation SlotMap. */
export type TurnTailOwner = OwnerOf<'conversation.chat.turnTail'>

type DialogState =
  | { kind: 'error'; message: string }
  | { kind: 'preview'; loading: boolean; alsoFork: boolean; changes: { op: 'restore' | 'delete'; path: string; size: number }[]; total: number; truncated: boolean }
  | { kind: 'done'; applied: number; skipped: number; alsoFork: boolean }
  | { kind: 'undone'; applied: number }

// ------------------------------------------------------------ dialog

interface TtDialogProps {
  dialog: DialogState
  time: string
  onCancel: () => void
  onConfirm: () => void
  onUndo: () => void
}

function TtDialog({ dialog, time, onCancel, onConfirm, onUndo }: TtDialogProps): ReactNode {
  const close = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation()
    onCancel()
  }
  const wrap = (children: ReactNode): ReactNode =>
    <div className="dsh-tt-dialog" onClick={(e) => e.stopPropagation()}>{children}</div>

  if (dialog.kind === 'error') {
    return (
      <div className="dsh-tt-overlay" onClick={close}>
        {wrap([
          <h3 key="h">回退失败</h3>,
          <p key="m" className="dsh-tt-error">{dialog.message}</p>,
          <div key="a" className="dsh-tt-actions"><button onClick={close}>关闭</button></div>,
        ])}
      </div>
    )
  }
  if (dialog.kind === 'preview') {
    const changes = dialog.changes
    const body = dialog.loading
      ? <p>正在比对工作区…</p>
      : changes.length === 0
        ? <p>工作区与该位置完全一致，无需恢复。</p>
        : <>
            <p>共 {dialog.total} 个文件将变更（回退前自动备份当前状态，可撤销）：</p>
            <ul className="dsh-tt-changes">
              {changes.slice(0, 200).map((c) => (
                <li key={c.path} className={'dsh-tt-change dsh-tt-' + c.op}>
                  <span className="dsh-tt-op">{c.op === 'delete' ? '删除' : '恢复'}</span>
                  {c.path}
                </li>
              ))}
            </ul>
            {dialog.truncated ? <p className="dsh-tt-desc">… 其余变更已省略</p> : null}
            <p className="dsh-tt-desc">注意：若当前有正在生成的回复，请等它结束后再执行。</p>
          </>
    const actions = dialog.loading || changes.length === 0
      ? <div className="dsh-tt-actions"><button onClick={close}>关闭</button></div>
      : <div className="dsh-tt-actions">
          <button className="dsh-tt-primary" onClick={onConfirm}>确认回退</button>
          <button onClick={close}>取消</button>
        </div>
    return (
      <div className="dsh-tt-overlay" onClick={close}>
        {wrap([
          <h3 key="h">回退工作区到{time ? '快照 ' + time : '该位置'}</h3>,
          <div key="b">{body}</div>,
          <div key="a">{actions}</div>,
        ])}
      </div>
    )
  }
  if (dialog.kind === 'done') {
    const note = dialog.alsoFork
      ? <p className="dsh-tt-desc">正在创建对话分支并切换…</p>
      : <p className="dsh-tt-desc">文件面板如显示旧内容，重新打开对应文件即可刷新。</p>
    return (
      <div className="dsh-tt-overlay" onClick={close}>
        {wrap([
          <h3 key="h">已回退</h3>,
          <p key="m">已恢复 {dialog.applied} 个文件{dialog.skipped > 0 ? '（' + dialog.skipped + ' 个跳过）' : ''}。</p>,
          <div key="n">{note}</div>,
          <div key="a" className="dsh-tt-actions">
            <button className="dsh-tt-primary" onClick={onUndo}>撤销回退</button>
            <button onClick={close}>关闭</button>
          </div>,
        ])}
      </div>
    )
  }
  return (
    <div className="dsh-tt-overlay" onClick={close}>
      {wrap([
        <h3 key="h">已撤销</h3>,
        <p key="m">工作区已恢复为回退前的状态（{dialog.applied} 个文件）。</p>,
        <div key="a" className="dsh-tt-actions"><button onClick={close}>关闭</button></div>,
      ])}
    </div>
  )
}

// ------------------------------------------------------ turn-tail entry

type TurnTailEntryProps = ComposedProps<'conversation.chat.turnTail', string, never, undefined, TtInjected, { seq: number }, undefined>

export function TurnTailEntry(props: TurnTailEntryProps): ReactNode {
  const seq = typeof props.seq === 'number' ? props.seq : null
  const { api, cwdOf, forkConversation } = props
  const sid = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : props.currentSessionId()
  const cwd = cwdOf(sid)
  const [snap, setSnap] = useState<{ phase: 'loading' } | { phase: 'ready'; meta: SnapshotMeta } | { phase: 'none' }>({ phase: 'loading' })
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (seq === null || !sid || !cwd) { setSnap({ phase: 'none' }); return }
    const cacheKey = sid + ':' + seq
    const cached = snapshotCache.get(cacheKey)
    if (cached !== undefined) { setSnap(cached); return }
    let alive = true
    void api.snapshot({ path: cwd, sessionId: sid, atSeq: seq }).then((env) => {
      const next: { phase: 'ready'; meta: SnapshotMeta } | { phase: 'none' } =
        env.ok && env.value.found && env.value.createdAt !== undefined
          ? { phase: 'ready', meta: env.value }
          : { phase: 'none' }
      snapshotCache.set(cacheKey, next)
      if (alive) setSnap(next)
    })
    return () => { alive = false }
  }, [seq, sid, cwd, api])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  if (seq === null || snap.phase !== 'ready' || !sid || !cwd) return null

  const forkOnly = (): void => {
    setMenuOpen(false)
    forkConversation(sid, seq).catch((error: unknown) => {
      setDialog({ kind: 'error', message: '分支失败：' + (error instanceof Error ? error.message : String(error)) })
    })
  }

  const previewThen = (alsoFork: boolean): void => {
    setMenuOpen(false)
    setDialog({ kind: 'preview', loading: true, alsoFork, changes: [], total: 0, truncated: false })
    void api.preview({ path: cwd, sessionId: sid, atSeq: seq }).then((env) => {
      setDialog((current) => {
        if (!current || current.kind !== 'preview' || current.alsoFork !== alsoFork) return current
        if (!env.ok) return { kind: 'error', message: errorMessage(env) }
        return {
          kind: 'preview', loading: false, alsoFork,
          changes: env.value.changes, total: env.value.total, truncated: env.value.truncated,
        }
      })
    })
  }

  const confirmRestore = (): void => {
    const alsoFork = dialog?.kind === 'preview' && dialog.alsoFork
    setDialog({ kind: 'preview', loading: true, alsoFork, changes: [], total: 0, truncated: false })
    void api.restore({ path: cwd, sessionId: sid, atSeq: seq }).then((env) => {
      if (!env.ok) { setDialog({ kind: 'error', message: errorMessage(env) }); return }
      if (alsoFork) {
        forkConversation(sid, seq).catch(() => {})
      }
      setDialog({ kind: 'done', applied: env.value.applied, skipped: env.value.skipped, alsoFork })
    })
  }

  const undoRestore = (): void => {
    void api.undo({ path: cwd, sessionId: sid }).then((env) => {
      if (!env.ok) { setDialog({ kind: 'error', message: errorMessage(env) }); return }
      setDialog({ kind: 'undone', applied: env.value.applied })
    })
  }

  const menuItem = (label: string, desc: string, onClick: () => void): ReactNode => (
    <button className="dsh-tt-item" onClick={onClick} type="button">
      <b>{label}</b>
      <span className="dsh-tt-desc">{desc}</span>
    </button>
  )

  return (
    <span className="dsh-tt-root" ref={rootRef}>
      <button
        className="dsh-tt-btn"
        type="button"
        title={'回退到此位置（快照 ' + timeOf(snap.meta.createdAt) + '）'}
        onClick={(event) => { event.stopPropagation(); setMenuOpen(!menuOpen) }}
      >
        {'↩'} 回退
      </button>
      {menuOpen
        ? <div className="dsh-tt-menu">
            {menuItem('恢复代码和对话', '文件回退 + 分支到此', () => previewThen(true))}
            {menuItem('恢复对话', '仅创建分支，不动文件', forkOnly)}
            {menuItem('恢复代码', '仅回退工作区文件', () => previewThen(false))}
          </div>
        : null}
      {dialog !== null
        ? <TtDialog
            dialog={dialog}
            time={timeOf(snap.meta.createdAt)}
            onCancel={() => setDialog(null)}
            onConfirm={confirmRestore}
            onUndo={undoRestore}
          />
        : null}
    </span>
  )
}

// ---------------------------------------------------------------- apply

export const inject = ['slots', 'sessions']

/** Chain selector: mount the entry on every completed turn with a numeric closing seq. */
const selectTurn = (owner: TurnTailOwner): { seq: number } | null =>
  typeof owner.seq === 'number' ? { seq: owner.seq } : null

export function apply(ctx: ClientContext): void {
  injectStyles()
  ctx.inject(['slots', 'conversation', 'sessions'], (scope) => {
    const sessions = scope.sessions
    const api = new TtApi()
    const face = (): TtInjected => ({
      api,
      sessionId: undefined, // replaced by the inject-factory parameter below
      currentSessionId: () => sessions.list.getSnapshot().current,
      cwdOf: (sessionId) => {
        const entry = sessionId === undefined ? undefined : sessions.list.getSnapshot().byId[sessionId]
        return entry?.cwd
      },
      forkConversation: (sessionId, atSeq) =>
        sessions.fork({ sessionId, atSeq, increaseTitle: true })
          .then((childId) => sessions.open(childId)),
    })
    scope.slots.inject('conversation.chat.turnTail', () =>
      scope.slots.register(
        {
          name: 'conversation.chat.turnTail',
          select: selectTurn,
          priority: 50,
          inject: (sessionId: SessionIdOf): TtInjected => {
            const base = face()
            return { ...base, sessionId }
          },
        },
        TurnTailEntry))
  })
}
