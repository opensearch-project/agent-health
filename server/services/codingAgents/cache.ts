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

function kiroIdePath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
  } else if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
  }
  return path.join(os.homedir(), '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent', 'workspace-sessions');
}

const DIR_SIGNATURE_FNS: Record<AgentKind, () => Promise<string>> = {
  'claude-code': () => dirSignature(CLAUDE_PROJECTS, f => f.endsWith('.jsonl'), false),
  'kiro': async () => {
    const [cliSig, ideSig] = await Promise.all([
      dirSignature(KIRO_CLI, f => f.endsWith('.jsonl'), false),
      dirSignature(kiroIdePath(), () => true, true),
    ]);
    return `${cliSig}|${ideSig}`;
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
    // If a refresh is in progress, wait for it
    if (this.refreshLock) {
      await this.refreshLock;
      return this.sessions;
    }

    // If the signature was checked recently, return cached data (even if empty)
    if (this.lastSignatureCheck > 0 && (Date.now() - this.lastSignatureCheck) < SIGNATURE_TTL_MS) {
      return this.sessions;
    }

    const sigFn = DIR_SIGNATURE_FNS[this.reader.agentName];
    if (!sigFn) return this.reader.getSessions();

    try {
      const currentSig = await sigFn();
      this.lastSignatureCheck = Date.now();
      if (currentSig !== this.signature || this.sessions.length === 0) {
        await this.fullRefresh();
      }
    } catch {
      // If signature check fails, use cache if available
      if (this.sessions.length === 0) {
        await this.fullRefresh();
      }
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

  private async _doFullRefresh(): Promise<void> {
    try {
      this.sessions = await this.reader.getSessions();
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
    // Wait for warmup to complete so first request gets real data
    if (this.warmupPromise) {
      await this.warmupPromise;
    }

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

  /** Start async warmup (non-blocking). */
  warmup(): void {
    this.warmupPromise = this._doWarmup();
  }

  private async _doWarmup(): Promise<void> {
    try {
      await Promise.all(
        [...this.readerCaches.values()].map(rc => rc.fullRefresh())
      );
    } catch { /* non-fatal */ }
    this.warmupPromise = null;
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
