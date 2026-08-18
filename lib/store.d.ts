/** Scanner / store configuration. */
export interface TtConfig {
    /** Directory/file names ignored at any depth. */
    ignore: string[];
    /** Per-file size cap; larger files are tracked but not snapshotted. */
    maxFileBytes: number;
}
/** Default ignore list applied to every scan (names at any depth). */
export declare const DEFAULT_IGNORE: string[];
/** Default per-file size cap; larger files are tracked but not snapshotted. */
export declare const DEFAULT_MAX_FILE_BYTES: number;
/** Default store root under the dsh home. */
export declare function defaultStoreRoot(): string;
/** Read the optional config file (~/.dsh/dsh-workspace-tt.json); defaults on any miss. */
export declare function readConfigSync(file?: string): TtConfig;
/** One file's manifest pair: content hash (null = too large to snapshot) and byte size. */
export type FilePair = [sha: string | null, size: number];
/** Full manifest: relative path -> [sha | null, size]. */
export type Manifest = Record<string, FilePair>;
/** One recorded snapshot entry. */
export interface SnapshotEntry {
    kind: 'turn' | 'backup';
    /** Turn key: the closing assistant seq (null on backups). */
    key: number | null;
    createdAt: number;
    files: Manifest;
}
/** A scan result: the file table plus skip counters. */
export interface ScanResult {
    files: Map<string, FilePair>;
    skipped: {
        large: number;
        symlinks: number;
        errors: number;
    };
}
/** One file change projected between the current workspace and a target manifest. */
export interface FileChange {
    op: 'restore' | 'delete';
    path: string;
    size: number;
}
export interface CaptureResult {
    entry: SnapshotEntry;
    skipped: boolean;
}
export interface ApplyResult {
    applied: number;
    skipped: number;
    changes: number;
}
/**
 * Workspace scanner with an mtime/size memo so consecutive snapshots only
 * re-hash files that actually changed. Symlinks are never followed (a
 * workspace symlink must not leak files outside the workspace into the
 * snapshot).
 */
export declare function createScanner(config: TtConfig): {
    scan: (root: string) => Promise<ScanResult>;
};
/**
 * Per-workspace, per-session snapshot log + content-addressed blob store.
 */
export declare class SnapshotStore {
    private readonly config;
    private readonly root;
    private readonly blobs;
    private readonly scanner;
    private readonly mem;
    constructor(config: TtConfig, root?: string);
    wsKey(workspace: string): string;
    sessionFile(workspace: string, sessionId: string): string;
    load(workspace: string, sessionId: string): Promise<{
        entries: SnapshotEntry[];
        dirty: boolean;
        file: string;
        workspace: string;
    }>;
    save(mem: {
        entries: SnapshotEntry[];
        dirty: boolean;
        file: string;
        workspace: string;
    }): Promise<void>;
    /**
     * Capture the workspace under 'key' (a turn's closing-assistant seq), or as
     * a backup entry when 'backup' is set (key: null, kind: 'backup').
     * @returns skipped=true when the manifest is unchanged from the previous
     *   turn entry (nothing was recorded).
     */
    capture(workspace: string, sessionId: string, key: number | null, opts?: {
        backup?: boolean;
        force?: boolean;
    }): Promise<CaptureResult>;
    /**
     * Find the snapshot for 'atSeq': the nearest turn entry with key <= atSeq,
     * searching the lineage (session id chain, nearest session first).
     */
    resolve(workspace: string, sessionIds: string[], atSeq: number): Promise<{
        entry: SnapshotEntry | null;
        sessionId: string | undefined;
    }>;
    /** Diff current workspace state against a target manifest. */
    diff(workspace: string, entry: SnapshotEntry): Promise<FileChange[]>;
    /** Apply a target manifest: write back changed files from blobs, delete files created later, prune empty dirs. */
    apply(workspace: string, entry: SnapshotEntry): Promise<ApplyResult>;
    backup(workspace: string, sessionId: string): Promise<CaptureResult>;
    lastBackup(workspace: string, sessionIds: string[]): Promise<{
        entry: SnapshotEntry | null;
        sessionId: string | undefined;
    }>;
    undo(workspace: string, sessionIds: string[]): Promise<ApplyResult & {
        found: boolean;
    }>;
}
