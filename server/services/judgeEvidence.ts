/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/** Materialize complete, immutable evidence for one in-process judgment. */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { JudgeRequest } from './bedrockService';
import { fetchTraceJudgeLogs, fetchTraceJudgeSpans } from './traceJudgeTools';
import { TraceStore } from '../adapters/file/TraceStore';
import type { RestrictedBashMount } from './restrictedBash';
import type { Span } from '../../types';

export type JudgeTraceMode = 'file' | 'cluster' | 'unknown';

export interface JudgeTraceEvidenceState {
  mode: JudgeTraceMode;
  /** True only when trace/log evidence is actually reachable by this judgment. */
  exists: boolean;
  spanCount: number;
  logCount: number;
}

export interface JudgeEvidenceBundle {
  rootDir: string;
  evidenceDir: string;
  scratchDir: string;
  /** Complete rendered tree entries, including virtual read-only mounts. */
  files: string[];
  /** Virtual-to-canonical mappings consumed by RestrictedBash (never symlinks/copies). */
  mounts: RestrictedBashMount[];
  trace: JudgeTraceEvidenceState;
}

function safeName(value: string | undefined): string {
  return (value || 'no-run').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80) || 'no-run';
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function ndjson(values: unknown[]): string {
  return values.map((value) => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');
}

async function makeReadOnly(dir: string): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(abs);
      await fs.chmod(abs, 0o555);
    } else {
      await fs.chmod(abs, 0o444);
    }
  }
  await fs.chmod(dir, 0o555);
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs);
    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      out.push(...await listFiles(root, abs));
    } else out.push(rel);
  }
  return out;
}

function traceMode(value: unknown): JudgeTraceMode {
  if (value === 'file') return 'file';
  if (value === 'opensearch') return 'cluster';
  return 'unknown';
}

/**
 * Build evidence from the ORIGINAL request trajectory, before prompt
 * compaction/truncation. Trace endpoint failures are non-fatal. In file mode,
 * trace and workspace bytes remain in their canonical stores: this bundle
 * contains an explicit read-only mount table, not copies or symlinks. Workspace
 * mounting relies on the judge's post-quiescence contract: connector execution
 * has completed and its run workspace is immutable before judgment begins.
 * Cluster mode never materializes or mounts trace data.
 */
export async function buildJudgeEvidence(
  request: JudgeRequest,
  serverUrl: string
): Promise<JudgeEvidenceBundle> {
  const prefix = path.join(os.tmpdir(), `agent-health-judge-${safeName(request.runId)}-`);
  const rootDir = await fs.mkdtemp(prefix);
  const evidenceDir = path.join(rootDir, 'evidence');
  const scratchDir = path.join(rootDir, 'scratch');
  const stepsDir = path.join(evidenceDir, 'steps');
  await fs.mkdir(stepsDir, { recursive: true });
  await fs.mkdir(scratchDir);

  try {
    await fs.writeFile(path.join(evidenceDir, 'testcase.json'), json({
      prompt: request.evidenceContext?.prompt,
      expectedOutcomes: request.expectedOutcomes ?? [],
      expectedTrajectory: request.expectedTrajectory ?? [],
    }));
    await fs.writeFile(path.join(evidenceDir, 'run.json'), json({
      runId: request.runId,
      agentKey: request.evidenceContext?.agentKey,
      timings: request.evidenceContext?.timings,
      metadata: request.evidenceContext?.metadata,
      agents: request.agents,
      trajectorySteps: request.trajectory.length,
      createdAt: new Date().toISOString(),
    }));
    await fs.writeFile(path.join(evidenceDir, 'trajectory.json'), json(request.trajectory));
    await fs.writeFile(path.join(evidenceDir, 'trajectory.ndjson'), ndjson(request.trajectory));

    const width = Math.max(3, String(request.trajectory.length).length);
    for (let i = 0; i < request.trajectory.length; i++) {
      const step: any = request.trajectory[i];
      const type = String(step?.type ?? 'step').replace(/[^a-zA-Z0-9_-]/g, '-');
      await fs.writeFile(
        path.join(stepsDir, `${String(i + 1).padStart(width, '0')}-${type}.json`),
        json(step)
      );
    }

    const mounts: RestrictedBashMount[] = [];

    // Execution has quiesced before the judge runs, so the recorded workspace
    // is immutable for the lifetime of this bundle. Expose that canonical tree
    // directly rather than making an unbounded snapshot. RestrictedBash rejects
    // links, traversal, sibling paths, and all writes through this mount.
    if (request.evidenceContext?.workspaceDir) {
      try {
        const source = request.evidenceContext.workspaceDir;
        const stat = await fs.lstat(source);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`workspace is not a non-symlink directory: ${source}`);
        mounts.push({ virtualPath: 'evidence/workspace', sourcePaths: [await fs.realpath(source)] });
      } catch (err: any) {
        await fs.writeFile(path.join(evidenceDir, 'workspace-error.txt'), `${err?.message ?? String(err)}\n`);
      }
    }
    let mode: JudgeTraceMode = 'unknown';
    let spanCount = 0;
    let logCount = 0;

    if (request.runId) {
      try {
        const spanData: any = await fetchTraceJudgeSpans(request.runId, serverUrl, request.agents);
        mode = traceMode(spanData?.backend);
        const spans: Span[] = Array.isArray(spanData?.spans) ? spanData.spans : [];
        spanCount = spans.length;
        if (mode === 'file' && spans.length) {
          const sourcePaths = await new TraceStore().canonicalFilesForSpans(spans);
          if (sourcePaths.length) mounts.push({ virtualPath: 'evidence/spans.ndjson', sourcePaths });
        }
      } catch {
        // Trace-free operation is intentional. Absence means unavailable.
      }
      try {
        const logData: any = await fetchTraceJudgeLogs(request.runId, serverUrl);
        const logs = Array.isArray(logData?.logs) ? logData.logs : [];
        logCount = logs.length;
        // The embedded file backend has no OTLP log receiver/store yet. When
        // one lands, mount its canonical NDJSON here exactly like spans.
      } catch {
        // Trace-free operation is intentional. Absence means unavailable.
      }
    }

    await makeReadOnly(evidenceDir);
    const physicalFiles = await listFiles(rootDir);
    const files = [...new Set([
      ...physicalFiles,
      ...mounts.map((mount) => `${mount.virtualPath}${mount.virtualPath === 'evidence/workspace' ? '/' : ''}`),
    ])].sort();
    const exists = mode === 'cluster'
      ? spanCount > 0 || logCount > 0
      : mode === 'file' && mounts.some((mount) => mount.virtualPath === 'evidence/spans.ndjson');
    return {
      rootDir,
      evidenceDir,
      scratchDir,
      files,
      mounts,
      trace: { mode, exists, spanCount, logCount },
    };
  } catch (err) {
    await fs.rm(rootDir, { recursive: true, force: true });
    throw err;
  }
}

export async function removeJudgeEvidence(bundle: JudgeEvidenceBundle): Promise<void> {
  // Restore owner permissions recursively: unlinking a file requires write
  // permission on its immediate parent directory.
  const makeWritable = async (dir: string): Promise<void> => {
    await fs.chmod(dir, 0o755).catch(() => undefined);
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) await makeWritable(path.join(dir, entry.name));
    }
  };
  await makeWritable(bundle.evidenceDir);
  await fs.rm(bundle.rootDir, { recursive: true, force: true });
}
