/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildJudgeEvidence, removeJudgeEvidence } from '@/server/services/judgeEvidence';
import { createEvidenceJudgeExtension } from '@/server/services/evidenceJudgeTools';
import { TraceStore } from '@/server/adapters/file/TraceStore';
import type { Span } from '@/types';

const request: any = {
  runId: 'run/full:1',
  trajectory: [
    { id: '1', timestamp: 1, type: 'action', content: 'call', toolName: 'read', toolArgs: { path: 'README.md' } },
    { id: '2', timestamp: 2, type: 'tool_result', content: 'x'.repeat(60_000), toolOutput: 'x'.repeat(60_000) },
  ],
  expectedOutcomes: ['enumerates tools', 'does not modify files'],
  evidenceContext: { prompt: 'inspect without writes', agentKey: 'example', timings: { agentDurationMs: 42 } },
};

const ORIGINAL_DATA_DIR = process.env.AGENT_HEALTH_DATA_DIR;

afterEach(() => {
  (global.fetch as any) = undefined;
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGENT_HEALTH_DATA_DIR;
  else process.env.AGENT_HEALTH_DATA_DIR = ORIGINAL_DATA_DIR;
});

function span(over: Partial<Span> = {}): Span {
  return {
    traceId: 'trace-1', spanId: 's1', name: 'execute_tool',
    startTime: '2024-01-01T00:00:00.000Z', endTime: '2024-01-01T00:00:00.100Z',
    duration: 100, status: 'OK',
    attributes: { 'session.id': request.runId, 'service.name': 'pi-agent', 'gen_ai.tool.name': 'read' },
    ...over,
  };
}

describe('judge evidence bundle', () => {
  it('writes the full untruncated trajectory, per-step files, and read-only evidence', async () => {
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ spans: [], logs: [] }) });
    const bundle = await buildJudgeEvidence(request, 'http://localhost:4001');
    try {
      const trajectory = JSON.parse(await fs.readFile(path.join(bundle.evidenceDir, 'trajectory.json'), 'utf8'));
      expect(trajectory[1].content).toHaveLength(60_000);
      expect(await fs.readFile(path.join(bundle.evidenceDir, 'trajectory.ndjson'), 'utf8')).toContain('"toolOutput":"xxx');
      expect(bundle.files).toEqual(expect.arrayContaining([
        'evidence/testcase.json',
        'evidence/run.json',
        'evidence/steps/001-action.json',
        'evidence/steps/002-tool_result.json',
        'scratch/',
      ]));
      expect(bundle.files).not.toContain('evidence/spans.ndjson');
      expect(bundle.files.some((file) => /README|manifest/i.test(file))).toBe(false);
      expect((await fs.stat(bundle.evidenceDir)).mode & 0o777).toBe(0o555);
      expect((await fs.stat(bundle.scratchDir)).mode & 0o777).toBe(0o755);
    } finally {
      await removeJudgeEvidence(bundle);
    }
    await expect(fs.stat(bundle.rootDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('mounts file-mode spans from the canonical store without copying an inode', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-trace-store-'));
    process.env.AGENT_HEALTH_DATA_DIR = dataDir;
    const stored = span({ attributes: { 'session.id': 'run-safe', 'service.name': 'pi-agent', 'gen_ai.tool.name': 'read' } });
    await new TraceStore().writeSpans([stored]);
    (global as any).fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ backend: 'file', spans: [stored] }) })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    const bundle = await buildJudgeEvidence(request, 'http://localhost:4001');
    try {
      expect(bundle.trace).toEqual(expect.objectContaining({ mode: 'file', exists: true, spanCount: 1 }));
      expect(bundle.files).toContain('evidence/spans.ndjson');
      expect(bundle.mounts).toHaveLength(1);
      expect(bundle.mounts[0].sourcePaths[0]).toMatch(/traces\/session-run-safe\.ndjson$/);
      await expect(fs.lstat(path.join(bundle.evidenceDir, 'spans.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' });

      const tools = new Map<string, any>();
      createEvidenceJudgeExtension(bundle.rootDir, { mounts: bundle.mounts })(
        { registerTool: (tool: any) => tools.set(tool.name, tool) } as any
      );
      const result = await tools.get('bash').execute('1', { command: "jq -s '.[0].spanId' evidence/spans.ndjson" });
      expect(result.content[0].text).toContain('s1');
    } finally {
      await removeJudgeEvidence(bundle);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('never materializes or mounts cluster-mode spans/logs', async () => {
    (global as any).fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ backend: 'opensearch', spans: [{ spanId: 's1' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ logs: [{ message: 'ok' }] }) });
    const bundle = await buildJudgeEvidence(request, 'http://localhost:4001');
    try {
      expect(bundle.trace).toEqual(expect.objectContaining({ mode: 'cluster', exists: true, spanCount: 1, logCount: 1 }));
      expect(bundle.mounts).toEqual([]);
      expect(bundle.files).not.toContain('evidence/spans.ndjson');
      expect(bundle.files).not.toContain('evidence/logs.ndjson');
      await expect(fs.lstat(path.join(bundle.evidenceDir, 'spans.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await removeJudgeEvidence(bundle); }
  });

  it('mounts a recorded workspace read-only without creating a copied inode', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'judge-workspace-'));
    await fs.mkdir(path.join(workspace, 'nested'));
    await fs.writeFile(path.join(workspace, 'nested', 'real.txt'), 'real\n');
    await fs.writeFile(path.join(workspace, 'large.bin'), '');
    await fs.truncate(path.join(workspace, 'large.bin'), 32 * 1024 * 1024);
    await fs.symlink('/etc/passwd', path.join(workspace, 'link'));
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ spans: [], logs: [] }) });
    const bundle = await buildJudgeEvidence({ ...request, evidenceContext: { ...request.evidenceContext, workspaceDir: workspace } }, 'http://localhost:4001');
    try {
      expect(bundle.mounts).toContainEqual({
        virtualPath: 'evidence/workspace',
        sourcePaths: [await fs.realpath(workspace)],
      });
      expect(bundle.files).toContain('evidence/workspace/');
      expect(bundle.files).not.toContain('evidence/workspace/nested/real.txt');
      expect(bundle.trace.exists).toBe(false);

      // No workspace directory or regular file exists in the judgment tmpdir;
      // even a large source is represented only by the mount-table entry.
      await expect(fs.lstat(path.join(bundle.evidenceDir, 'workspace'))).rejects.toMatchObject({ code: 'ENOENT' });
      const physicalEntries = await fs.readdir(bundle.evidenceDir);
      expect(physicalEntries.some((entry) => entry.startsWith('workspace'))).toBe(false);

      const tools = new Map<string, any>();
      createEvidenceJudgeExtension(bundle.rootDir, { mounts: bundle.mounts })(
        { registerTool: (tool: any) => tools.set(tool.name, tool) } as any
      );
      expect((await tools.get('bash').execute('1', { command: 'cat evidence/workspace/nested/real.txt' })).content[0].text)
        .toContain('real');
      expect((await tools.get('bash').execute('2', { command: 'cat evidence/workspace/link' })).content[0].text)
        .toMatch(/symlinks are not allowed/);
      expect((await tools.get('bash').execute('3', { command: 'echo changed > evidence/workspace/nested/real.txt' })).content[0].text)
        .toMatch(/writes are allowed only under scratch/);
    } finally {
      await removeJudgeEvidence(bundle);
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});

describe('evidence bash pi extension', () => {
  it('registers bash and returns stdout/stderr plus exit semantics', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-tool-'));
    await fs.mkdir(path.join(root, 'evidence'));
    await fs.mkdir(path.join(root, 'scratch'));
    await fs.writeFile(path.join(root, 'evidence', 'a'), 'hello\n');
    const tools = new Map<string, any>();
    createEvidenceJudgeExtension(root)({ registerTool: (tool: any) => tools.set(tool.name, tool) });
    expect([...tools.keys()]).toEqual(['bash']);
    expect((await tools.get('bash').execute('1', { command: 'cat evidence/a' })).content[0].text).toBe('hello\n[exit 0]');
    expect((await tools.get('bash').execute('2', { command: 'cat /etc/passwd' })).content[0].text).toMatch(/outside judgment directory[\s\S]*\[exit 2\]/);
    await fs.rm(root, { recursive: true, force: true });
  });
});
