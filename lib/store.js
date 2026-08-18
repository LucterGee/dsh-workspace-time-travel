/**
 * dsh-workspace-time-travel — snapshot store core (no cordis imports; unit-testable).
 *
 * A snapshot is a full manifest of the workspace file tree at one point in
 * time: relative path -> [sha256 | null, byte size]. File bytes live in a
 * content-addressed blob dir (deduplicated across snapshots); 'sha: null'
 * marks files too large to snapshot (they are tracked but never restored).
 *
 * Snapshots are keyed by a *turn key*: the seq of the turn's closing
 * assistant message (the same seq the conversation fork button uses as its
 * boundary anchor). A turn that changed nothing is not re-recorded — the
 * lookup falls back to the nearest earlier key, which is correct because the
 * workspace was identical then.
 *
 * @module dsh-workspace-time-travel/store
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
/** Default ignore list applied to every scan (names at any depth). */
export const DEFAULT_IGNORE = ['.git', 'node_modules', '.DS_Store', '.idea', '.vscode'];
/** Default per-file size cap; larger files are tracked but not snapshotted. */
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Default store root under the dsh home. */
export function defaultStoreRoot() {
    return join(homedir(), '.dsh', 'storages', 'dsh-workspace-time-travel');
}
/** Read the optional config file (~/.dsh/dsh-workspace-tt.json); defaults on any miss. */
export function readConfigSync(file = join(homedir(), '.dsh', 'dsh-workspace-tt.json')) {
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        return {
            ignore: Array.isArray(raw.ignore) && raw.ignore.length > 0 ? raw.ignore.map(String) : [...DEFAULT_IGNORE],
            maxFileBytes: typeof raw.maxFileBytes === 'number' && raw.maxFileBytes > 0 ? raw.maxFileBytes : DEFAULT_MAX_FILE_BYTES,
        };
    }
    catch {
        return { ignore: [...DEFAULT_IGNORE], maxFileBytes: DEFAULT_MAX_FILE_BYTES };
    }
}
/** Stream-sha256 one file. */
function sha256Stream(file) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(file);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
/**
 * Workspace scanner with an mtime/size memo so consecutive snapshots only
 * re-hash files that actually changed. Symlinks are never followed (a
 * workspace symlink must not leak files outside the workspace into the
 * snapshot).
 */
export function createScanner(config) {
    const cache = new Map();
    async function scan(root) {
        const files = new Map();
        const skipped = { large: 0, symlinks: 0, errors: 0 };
        async function walk(dir) {
            let entries;
            try {
                entries = await readdir(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            for (const entry of entries) {
                if (config.ignore.includes(entry.name))
                    continue;
                const abs = join(dir, entry.name);
                const rel = relative(root, abs).split(sep).join('/');
                if (entry.isSymbolicLink()) {
                    skipped.symlinks++;
                    continue;
                }
                if (entry.isDirectory()) {
                    await walk(abs);
                    continue;
                }
                if (!entry.isFile())
                    continue;
                let st;
                try {
                    st = await stat(abs);
                }
                catch {
                    skipped.errors++;
                    continue;
                }
                const cached = cache.get(rel);
                if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
                    files.set(rel, [cached.sha, st.size]);
                    continue;
                }
                if (st.size > config.maxFileBytes) {
                    cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, sha: null });
                    files.set(rel, [null, st.size]);
                    skipped.large++;
                    continue;
                }
                try {
                    const sha = await sha256Stream(abs);
                    cache.set(rel, { mtimeMs: st.mtimeMs, size: st.size, sha });
                    files.set(rel, [sha, st.size]);
                }
                catch {
                    skipped.errors++;
                }
            }
        }
        await walk(root);
        return { files, skipped };
    }
    return { scan };
}
/** Two manifests are equal when the size and every entry match. */
function sameManifest(a, b) {
    if (a === b)
        return true;
    if (a === undefined)
        return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length)
        return false;
    for (const key of keysA) {
        const ea = a[key];
        const eb = b[key];
        if (ea === undefined || eb === undefined)
            return false;
        if (ea[0] !== eb[0] || ea[1] !== eb[1])
            return false;
    }
    return true;
}
/**
 * Per-workspace, per-session snapshot log + content-addressed blob store.
 */
export class SnapshotStore {
    config;
    root;
    blobs;
    scanner;
    mem = new Map();
    constructor(config, root = defaultStoreRoot()) {
        this.config = config;
        this.root = root;
        this.blobs = join(root, 'blobs');
        this.scanner = createScanner(config);
    }
    wsKey(workspace) {
        return createHash('sha1').update(workspace).digest('hex').slice(0, 20);
    }
    sessionFile(workspace, sessionId) {
        return join(this.root, this.wsKey(workspace), sessionId + '.json');
    }
    async load(workspace, sessionId) {
        const memKey = this.wsKey(workspace) + '\u0000' + sessionId;
        const existing = this.mem.get(memKey);
        if (existing !== undefined)
            return existing;
        let record = { entries: [] };
        try {
            const raw = JSON.parse(await readFile(this.sessionFile(workspace, sessionId), 'utf8'));
            if (Array.isArray(raw.entries))
                record = { entries: raw.entries };
        }
        catch { /* first snapshot for this session */ }
        const mem = { ...record, dirty: false, file: this.sessionFile(workspace, sessionId), workspace };
        this.mem.set(memKey, mem);
        return mem;
    }
    async save(mem) {
        if (!mem.dirty)
            return;
        await mkdir(dirname(mem.file), { recursive: true });
        const tmp = mem.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
        await writeFile(tmp, JSON.stringify({ workspace: mem.workspace, entries: mem.entries }), 'utf8');
        await rename(tmp, mem.file);
        mem.dirty = false;
    }
    /**
     * Capture the workspace under 'key' (a turn's closing-assistant seq), or as
     * a backup entry when 'backup' is set (key: null, kind: 'backup').
     * @returns skipped=true when the manifest is unchanged from the previous
     *   turn entry (nothing was recorded).
     */
    async capture(workspace, sessionId, key, opts = {}) {
        const backup = opts.backup === true;
        const force = opts.force === true;
        const mem = await this.load(workspace, sessionId);
        const { files, skipped } = await this.scanner.scan(workspace);
        const previous = [...mem.entries].reverse().find((entry) => entry.kind === 'turn');
        if (!force && !backup && previous !== undefined && sameManifest(previous.files, Object.fromEntries(files))) {
            return { entry: previous, skipped: true };
        }
        await mkdir(this.blobs, { recursive: true });
        for (const [rel, pair] of files) {
            const sha = pair[0];
            if (sha === null)
                continue;
            const blob = join(this.blobs, sha);
            if (existsSync(blob))
                continue;
            const tmp = blob + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
            try {
                await copyFile(join(workspace, rel), tmp);
                await rename(tmp, blob);
            }
            catch {
                await rm(tmp, { force: true }).catch(() => { });
            }
        }
        const entry = {
            kind: backup ? 'backup' : 'turn',
            key: backup ? null : key,
            createdAt: Date.now(),
            files: Object.fromEntries(files),
        };
        mem.entries.push(entry);
        mem.dirty = true;
        await this.save(mem);
        return { entry, skipped: false };
    }
    /**
     * Find the snapshot for 'atSeq': the nearest turn entry with key <= atSeq,
     * searching the lineage (session id chain, nearest session first).
     */
    async resolve(workspace, sessionIds, atSeq) {
        for (const sessionId of sessionIds) {
            const mem = await this.load(workspace, sessionId);
            for (let i = mem.entries.length - 1; i >= 0; i--) {
                const entry = mem.entries[i];
                if (entry.kind === 'turn' && typeof entry.key === 'number' && entry.key <= atSeq) {
                    return { entry, sessionId };
                }
            }
        }
        return { entry: null, sessionId: undefined };
    }
    /** Diff current workspace state against a target manifest. */
    async diff(workspace, entry) {
        const { files } = await this.scanner.scan(workspace);
        const target = entry.files;
        const changes = [];
        for (const rel of Object.keys(target)) {
            const pair = target[rel];
            const sha = pair[0];
            const size = pair[1];
            const current = files.get(rel);
            if (current === undefined)
                changes.push({ op: 'restore', path: rel, size });
            else if (current[0] !== null && sha !== null && current[0] !== sha)
                changes.push({ op: 'restore', path: rel, size });
        }
        for (const rel of files.keys()) {
            if (!Object.prototype.hasOwnProperty.call(target, rel)) {
                changes.push({ op: 'delete', path: rel, size: files.get(rel)?.[1] ?? 0 });
            }
        }
        return changes;
    }
    /** Apply a target manifest: write back changed files from blobs, delete files created later, prune empty dirs. */
    async apply(workspace, entry) {
        const changes = await this.diff(workspace, entry);
        const target = entry.files;
        let applied = 0;
        let skipped = 0;
        const emptiedDirs = new Set();
        for (const change of changes) {
            const abs = join(workspace, change.path);
            if (change.op === 'restore') {
                const sha = target[change.path]?.[0] ?? null;
                if (sha === null) {
                    skipped++;
                    continue;
                }
                try {
                    await mkdir(dirname(abs), { recursive: true });
                    await copyFile(join(this.blobs, sha), abs);
                    applied++;
                }
                catch {
                    skipped++;
                }
            }
            else {
                try {
                    await rm(abs, { force: true });
                    applied++;
                    for (let dir = dirname(abs); dir.length > workspace.length && dir.startsWith(workspace + sep); dir = dirname(dir)) {
                        emptiedDirs.add(dir);
                    }
                }
                catch {
                    skipped++;
                }
            }
        }
        for (const dir of [...emptiedDirs].sort((a, b) => b.length - a.length)) {
            try {
                await rmdir(dir);
            }
            catch { /* still non-empty */ }
        }
        return { applied, skipped, changes: changes.length };
    }
    async backup(workspace, sessionId) {
        return this.capture(workspace, sessionId, null, { backup: true, force: true });
    }
    async lastBackup(workspace, sessionIds) {
        for (const sessionId of sessionIds) {
            const mem = await this.load(workspace, sessionId);
            for (let i = mem.entries.length - 1; i >= 0; i--) {
                if (mem.entries[i].kind === 'backup')
                    return { entry: mem.entries[i], sessionId };
            }
        }
        return { entry: null, sessionId: undefined };
    }
    async undo(workspace, sessionIds) {
        const { entry } = await this.lastBackup(workspace, sessionIds);
        if (entry === null)
            return { applied: 0, skipped: 0, changes: 0, found: false };
        const result = await this.apply(workspace, entry);
        return { ...result, found: true };
    }
}
