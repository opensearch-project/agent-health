/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * In-memory session cache with directory-level invalidation and
 * active-session refresh. Eliminates redundant filesystem scans.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { CodingAgentReader, AgentSession, AgentKind } from './types';

// ─── Directory Signature Helpers ────────────────────────────────────────────

/** Compute a fingerprint for a directory: "latestMtime:fileCount". */
async function dirSignature(baseDir: string, fileFilter: (name: string) => boolean, recursive = false): Promise<string> {
  let fileCount = 0;
  let latestMtime = 0;
  try {
    const stat = await fs.stat(baseDir);
    latestMtime = stat.mtimeMs;
    await walkDir(baseDir, fileFilter, recursive, (mtime) => {
      fileCount++;
      if (mtime > latestMtime) latestMtime = mtime;
    });
  } catch { /* dir doesn't exist */ }
  return `${Math.floor(latestMtime)}:${fileCount}`;
}

async function walkDir(
  dir: string,
  fileFilter: (name: string) => boolean,
  recursive: boolean,
  onFile: (mtimeMs: number) => void,
): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) {
          await walkDir(fullPath, fileFilter, true, onFile);
        } else {
          // Check files inside one-level subdirectories (Claude Code pattern)
          try {
            const subStat = await fs.stat(fullPath);
            if (subStat.mtimeMs > 0) {
              const subEntries = await fs.readdir(fullPath);
              for (const f of subEntries) {
                if (fileFilter(f)) {
                  onFile(subStat.mtimeMs);
                }
              }
            }
          } catch { /* skip */ }
        }
      } else if (fileFilter(entry.name)) {
        try {
          const stat = await fs.stat(fullPath);
          onFile(stat.mtimeMs);
        } catch {
          onFile(0);
        }
      }
    }
  } catch { /* skip */ }
}

const CLAUDE_PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const KIRO_CLI = path.join(os.homedir(), '.kiro', 'sessions', 'cli');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

import { kiroCliDataDir } from './readers/kiro';

function kiroIdePath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
  } else if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
  }
  return path.join(os.homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
}

function kiroIdeBasePath(): string {
  // Parent of workspace-sessions — strip the last segment
  return path.dirname(kiroIdePath());
}

/** Compute signature across all hash-based .chat workspace dirs. */
async function kiroChatDirSignature(): Promise<string> {
  const baseDir = kiroIdeBasePath();
  let fileCount = 0;
  let latestMtime = 0;
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !/^[0-9a-f]{32}$/.test(e.name)) continue;
      const dp = path.join(baseDir, e.name);
      const files = await fs.readdir(dp);
      for (const f of files) {
        if (!f.endsWith('.chat')) continue;
        fileCount++;
        try {
          const stat = await fs.stat(path.join(dp, f));
          if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
        } catch { /* skip */ }
      }
    }
  } catch { /* dir doesn't exist */ }
  return `${Math.floor(latestMtime)}:${fileCount}`;
}

const DIR_SIGNATURE_FNS: Record<AgentKind, () => Promise<string>> = {
  'claude-code': () => dirSignature(CLAUDE_PROJECTS, f => f.endsWith('.jsonl'), false),
  'kiro': async () => {
    const [cliSig, ideSig, chatSig, dbSig] = await Promise.all([
      dirSignature(KIRO_CLI, f => f.endsWith('.jsonl'), false),
      dirSignature(kiroIdePath(), () => true, true),
      kiroChatDirSignature(),
      dirSignature(
        kiroCliDataDir(),
        f => f === 'data.sqlite3',
        false,
      ),
    ]);
    return `${cliSig}|${ideSig}|${chatSig}|${dbSig}`;
  },
  'codex': () => dirSignature(CODEX_SESSIONS, f => f.startsWith('rollout-') && f.endsWith('.jsonl'), true),
};

// ─── Reader Cache ───────────────────────────────────────────────────────────

/** How long to trust the cached signature before re-checking the directory (ms). */
const SIGNATURE_TTL_MS = 5_000;

export class ReaderCache {
  private sessions: AgentSession[] = [];
  private fileMap = new Map<string, { filePath: string; mtimeMs: number }>();
  private signature = '';
  private lastSignatureCheck = 0;
  private lastFullRefresh = 0;
  private refreshLock: Promise<void> | null = null;

  constructor(private reader: CodingAgentReader) {}

  /** Return cached sessions, refreshing if directory signature changed.
   *  Skips signature check if within TTL window to avoid blocking the event loop. */
  async getSessions(): Promise<AgentSession[]> {
    // If first load and refresh in progress, wait for it
    if (this.sessions.length === 0 && this.refreshLock) {
      await this.refreshLock;
    }
    return this.sessions;
  }

  /** Full refresh: re-read all sessions from disk. */
  async fullRefresh(): Promise<void> {
    if (this.refreshLock) {
      await this.refreshLock;
      return;
    }

    this.refreshLock = this._doFullRefresh();
    try {
      await this.refreshLock;
    } finally {
      this.refreshLock = null;
    }
  }

  /** Fast refresh: only load sessions modified since `sinceMs`. */
  async fastRefresh(sinceMs: number): Promise<void> {
    try {
      const recent = await this.reader.getSessions(sinceMs);
      if (recent.length > 0) {
        // Merge with any existing sessions (avoid duplicates)
        const existing = new Set(this.sessions.map(s => s.session_id));
        for (const s of recent) {
          if (!existing.has(s.session_id)) this.sessions.push(s);
        }
        this.lastFullRefresh = Date.now();
      }
    } catch { /* non-fatal — full refresh will follow */ }
  }

  private async _doFullRefresh(): Promise<void> {
    try {
      const fresh = await this.reader.getSessions();
      // Merge: prefer fresh data, but keep fast-pass entries not in fresh set
      const freshIds = new Set(fresh.map(s => s.session_id));
      const kept = this.sessions.filter(s => !freshIds.has(s.session_id));
      this.sessions = [...fresh, ...kept];
      const sigFn = DIR_SIGNATURE_FNS[this.reader.agentName];
      if (sigFn) this.signature = await sigFn();
      this.lastFullRefresh = Date.now();

      // Build file map for active session tracking
      this.fileMap.clear();
      for (const s of this.sessions) {
        if (s._filePath) {
          try {
            const stat = await fs.stat(s._filePath);
            this.fileMap.set(s.session_id, { filePath: s._filePath, mtimeMs: stat.mtimeMs });
          } catch { /* file may have been deleted */ }
        }
      }
    } catch {
      // Keep existing cache on error
    }
  }

  /** Re-read only active (non-completed) sessions whose file mtime changed.
   *  Returns true if any data was updated. */
  async refreshActiveSessions(): Promise<boolean> {
    // First check if directory signature changed (new sessions)
    const sigFn = DIR_SIGNATURE_FNS[this.reader.agentName];
    if (sigFn) {
      try {
        const currentSig = await sigFn();
        if (currentSig !== this.signature) {
          await this.fullRefresh();
          return true;
        }
      } catch {
        // Signature check failed — force a full refresh to avoid stale data
        await this.fullRefresh();
        return true;
      }
    }

    // Find active sessions and check their file mtimes
    const activeSessions = this.sessions.filter(s => !s.session_completed);
    if (activeSessions.length === 0) return false;

    let needsMergeRebuild = false;
    for (const session of activeSessions) {
      const cached = this.fileMap.get(session.session_id);
      if (!cached?.filePath) continue;

      try {
        const stat = await fs.stat(cached.filePath);
        if (stat.mtimeMs > cached.mtimeMs) {
          // File changed — re-read only this single session file
          let fresh: AgentSession | null = null;
          if (this.reader.rereadSession) {
            fresh = await this.reader.rereadSession(cached.filePath);
          }
          if (fresh) {
            const idx = this.sessions.findIndex(s => s.session_id === session.session_id);
            if (idx !== -1) {
              this.sessions[idx] = fresh;
              this.fileMap.set(session.session_id, { filePath: fresh._filePath || cached.filePath, mtimeMs: stat.mtimeMs });
              needsMergeRebuild = true;
            }
          }
        }
      } catch { /* file may have been deleted */ }
    }

    if (needsMergeRebuild) {
      this.lastFullRefresh = Date.now();
    }
    return needsMergeRebuild;
  }

  getLastRefreshTime(): number {
    return this.lastFullRefresh;
  }
}

// ─── Session Cache Manager ──────────────────────────────────────────────────

export class SessionCacheManager {
  private readerCaches = new Map<AgentKind, ReaderCache>();
  private mergedCache: AgentSession[] | null = null;
  private mergedAt = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private warmupPromise: Promise<void> | null = null;

  constructor(readers: CodingAgentReader[]) {
    for (const r of readers) {
      this.readerCaches.set(r.agentName, new ReaderCache(r));
    }
  }

  /** Get all sessions (merged, sorted, _filePath stripped). */
  async getAllSessionsCached(): Promise<AgentSession[]> {


    // Check if any reader cache has been refreshed since last merge
    let needsMerge = this.mergedCache === null;
    for (const rc of this.readerCaches.values()) {
      if (rc.getLastRefreshTime() > this.mergedAt) {
        needsMerge = true;
        break;
      }
    }

    if (needsMerge) {
      const allArrays = await Promise.all(
        [...this.readerCaches.values()].map(rc => rc.getSessions())
      );
      const merged = allArrays.flat().sort(
        (a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime()
      );
      // Strip internal _filePath before exposing
      this.mergedCache = merged.map(({ _filePath, ...rest }) => rest as AgentSession);
      this.mergedAt = Date.now();
    }

    return this.mergedCache!;
  }

  /** How many days of data have been loaded so far. */
  loadedDays(): number {
    return this._loadedDays;
  }

  /** Whether background data loading is still in progress. */
  isBackfilling(): boolean {
    return this.backfillInProgress;
  }

  private backfillInProgress = false;
  private _loadedDays = 0;

  /** Start async warmup. Fast pass resolves quickly for immediate serving. */
  warmup(): void {
    this.fastPassDone = this._doWarmup();
  }

  /** Wait for the fast pass to complete (call before serving first request). */
  async waitForFastPass(): Promise<void> {
    if (this.fastPassDone) await this.fastPassDone;
  }

  private fastPassDone: Promise<void> | null = null;

  private async _doWarmup(): Promise<void> {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Phase 1: today + 7 days in parallel — unblocks server
    try {
      await Promise.all(
        [...this.readerCaches.values()].map(rc => rc.fastRefresh(todayStart.getTime()))
      );
      this._loadedDays = 1;
      this.invalidateMergedCache();
    } catch { /* non-fatal */ }
    this.warmupPromise = null; // fast pass done

    // Phase 2: progressive backfill in background
    this.backfillInProgress = true;
    (async () => {
      // 7 days (~2s)
      try {
        await Promise.all(
          [...this.readerCaches.values()].map(rc => rc.fastRefresh(now - 7 * 86_400_000))
        );
        this._loadedDays = 7;
        this.invalidateMergedCache();
      } catch { /* non-fatal */ }

      // 30 days (~20s)
      try {
        await Promise.all(
          [...this.readerCaches.values()].map(rc => rc.fastRefresh(now - 30 * 86_400_000))
        );
        this._loadedDays = 30;
        this.invalidateMergedCache();
      } catch { /* non-fatal */ }

      // Full scan (slow — only if needed)
      try {
        await Promise.all(
          [...this.readerCaches.values()].map(rc =>
            rc.fullRefresh().then(() => this.invalidateMergedCache())
          )
        );
      } catch { /* non-fatal */ }

      this._loadedDays = Infinity;
      this.backfillInProgress = false;
      this.invalidateMergedCache();
    })();
  }

  /** Force merged cache to rebuild on next access. */
  private invalidateMergedCache(): void {
    this.mergedCache = null;
    this.mergedAt = 0;
  }

  /** Start background refresh interval for active sessions. */
  startBackgroundRefresh(intervalMs = 30_000): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(async () => {
      try {
        const results = await Promise.all(
          [...this.readerCaches.values()].map(rc => rc.refreshActiveSessions())
        );
        // Only invalidate merged cache if any reader actually updated data
        if (results.some(changed => changed)) {
          this.mergedCache = null;
        }
      } catch { /* non-fatal */ }
    }, intervalMs);
    // Don't prevent Node.js from exiting
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  /** Stop background refresh. */
  stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
