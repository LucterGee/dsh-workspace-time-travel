import { realpath } from 'node:fs/promises';
import { SnapshotStore, readConfigSync } from './store.js';
/** Required services: the route registry, the workspace registry (security gate), and the session store. */
export const inject = ['webServer', 'workspaceRegistry', 'sessions'];
const BAD_REQUEST = { code: 'internal', message: 'malformed request' };
const NO_SNAPSHOT = { code: 'no-snapshot', message: 'no workspace snapshot for this position' };
const NO_BACKUP = { code: 'no-backup', message: 'no undo backup available' };
const BODY_CAP_BYTES = 1 << 20;
const OK = (value) => ({ ok: true, value });
const FAIL = (error) => ({ ok: false, error });
function isLoopbackRequest(req) {
    const addr = req.socket?.remoteAddress ?? '';
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
function forbidden(res) {
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'forbidden: loopback-only' }));
}
function json(res, envelope, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(envelope));
}
async function readJsonBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        const part = chunk;
        total += part.length;
        if (total > BODY_CAP_BYTES) {
            req.destroy();
            return null;
        }
        chunks.push(part);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (text === '')
        return null;
    try {
        const parsed = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null ? parsed : null;
    }
    catch {
        return null;
    }
}
export function apply(ctx) {
    const store = new SnapshotStore(readConfigSync());
    // --- workspace snapshots, driven by the session event log --------------
    const lastAssistantSeq = new Map(); // sessionId -> seq of the newest assistant/message
    const timers = new Map(); // sessionId -> debounce timer for the pending snapshot
    const cwdOf = (session) => {
        if (typeof session.header.cwd === 'string' && session.header.cwd !== '') {
            return session.header.cwd;
        }
        const ws = ctx.workspaceRegistry.list().find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(session.id));
        return typeof ws?.path === 'string' ? ws.path : undefined;
    };
    ctx.on('session/event', (session, event) => {
        try {
            if (event.type === 'assistant/message') {
                lastAssistantSeq.set(session.id, event.seq);
            }
            else if (event.type === 'turn/end') {
                const cwd = cwdOf(session);
                if (cwd === undefined)
                    return;
                // Key snapshots by the turn's closing assistant seq — the same
                // boundary anchor the conversation fork button uses.
                const key = lastAssistantSeq.get(session.id) ?? event.seq;
                const previous = timers.get(session.id);
                if (previous !== undefined)
                    clearTimeout(previous);
                const timer = setTimeout(() => {
                    timers.delete(session.id);
                    void store.capture(cwd, session.id, key).then((result) => {
                        if (!result.skipped) {
                            ctx.logger.info('dsh-workspace-tt: snapshot ' + session.id + ' key=' + key);
                        }
                    }).catch((error) => {
                        ctx.logger.warn('dsh-workspace-tt: snapshot failed: ' + (error instanceof Error ? error.message : String(error)));
                    });
                }, 250);
                timers.set(session.id, timer);
            }
        }
        catch (error) {
            ctx.logger.warn('dsh-workspace-tt: event handler failed: ' + String(error));
        }
    });
    // --- /tt routes ---------------------------------------------------------
    const lineageOf = (sessionId) => {
        const ids = [];
        const seen = new Set();
        let current = ctx.sessions.get(sessionId);
        while (current !== undefined && !seen.has(current.id)) {
            seen.add(current.id);
            ids.push(current.id);
            const parent = current.header.parentSession;
            current = typeof parent === 'string' ? ctx.sessions.get(parent) : undefined;
        }
        return ids;
    };
    // Security boundary, same posture as dsh-git-graph: the browser may only
    // snapshot/restore registered workspace roots, never arbitrary host dirs.
    const gate = async (path) => {
        let canonical;
        try {
            canonical = await realpath(path);
        }
        catch {
            return { ok: false, error: { code: 'workspace-unknown', message: 'path does not resolve on disk' } };
        }
        if (ctx.workspaceRegistry.list().some((workspace) => workspace.path === canonical)) {
            return { ok: true, canonical };
        }
        return { ok: false, error: { code: 'workspace-unknown', message: 'path is not a registered workspace' } };
    };
    const handler = async (req, res) => {
        if (!isLoopbackRequest(req)) {
            forbidden(res);
            return;
        }
        if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
        }
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.toLowerCase().startsWith('application/json')) {
            res.writeHead(415);
            res.end();
            return;
        }
        const pathname = new URL(req.url ?? '/', 'http://x').pathname;
        const payload = await readJsonBody(req);
        if (payload === null) {
            json(res, FAIL(BAD_REQUEST));
            return;
        }
        const path = typeof payload.path === 'string' && payload.path !== '' ? payload.path : null;
        const rawSessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : null;
        const sessionId = rawSessionId === null ? null : rawSessionId;
        const atSeq = typeof payload.atSeq === 'number' && Number.isFinite(payload.atSeq) ? Math.floor(payload.atSeq) : null;
        if (path === null || sessionId === null) {
            json(res, FAIL(BAD_REQUEST));
            return;
        }
        const gated = await gate(path);
        if (!gated.ok) {
            json(res, FAIL(gated.error));
            return;
        }
        const lineage = lineageOf(sessionId);
        if (lineage.length === 0) {
            json(res, FAIL({ code: 'session-unknown', message: 'unknown session' }));
            return;
        }
        switch (pathname) {
            case '/tt/snapshot': {
                if (atSeq === null)
                    return json(res, FAIL(BAD_REQUEST));
                const resolved = await store.resolve(gated.canonical, lineage, atSeq);
                if (resolved.entry === null)
                    return json(res, OK({ found: false }));
                return json(res, OK({
                    found: true,
                    key: resolved.entry.key,
                    createdAt: resolved.entry.createdAt,
                    fileCount: Object.keys(resolved.entry.files).length,
                }));
            }
            case '/tt/preview': {
                if (atSeq === null)
                    return json(res, FAIL(BAD_REQUEST));
                const resolved = await store.resolve(gated.canonical, lineage, atSeq);
                if (resolved.entry === null)
                    return json(res, FAIL(NO_SNAPSHOT));
                const changes = await store.diff(gated.canonical, resolved.entry);
                return json(res, OK({
                    changes: changes.slice(0, 400),
                    total: changes.length,
                    truncated: changes.length > 400,
                }));
            }
            case '/tt/restore': {
                if (atSeq === null)
                    return json(res, FAIL(BAD_REQUEST));
                const resolved = await store.resolve(gated.canonical, lineage, atSeq);
                if (resolved.entry === null)
                    return json(res, FAIL(NO_SNAPSHOT));
                const backup = await store.backup(gated.canonical, sessionId);
                const result = await store.apply(gated.canonical, resolved.entry);
                return json(res, OK({ ...result, backupId: String(backup.entry.createdAt) }));
            }
            case '/tt/undo': {
                const result = await store.undo(gated.canonical, lineage);
                if (!result.found)
                    return json(res, FAIL(NO_BACKUP));
                return json(res, OK({ applied: result.applied, skipped: result.skipped, changes: result.changes }));
            }
            default:
                res.writeHead(404);
                res.end();
        }
    };
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/tt', handler }), 'dsh-workspace-tt: /tt routes');
}
