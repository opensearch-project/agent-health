/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import { join, resolve } from 'path';

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockReaddirSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockCopyFileSync = jest.fn();
const mockMkdirSync = jest.fn();
const mockExecSync = jest.fn();
const mockHomedir = jest.fn();
const mockPlatform = jest.fn();
const mockDebug = jest.fn();
const mockProjectDataDir = jest.fn();
const mockLoadConfigSync = jest.fn();
const mockGetCustomAgents = jest.fn();
const mockParseSkill = jest.fn();
const mockRunSkillEval = jest.fn();
const mockProposeImprovement = jest.fn();
const mockGenerateEvals = jest.fn();

mockProjectDataDir.mockReturnValue('/tmp/agent-health-data');

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
    readdirSync: (...args: any[]) => mockReaddirSync(...args),
    writeFileSync: (...args: any[]) => mockWriteFileSync(...args),
    copyFileSync: (...args: any[]) => mockCopyFileSync(...args),
    mkdirSync: (...args: any[]) => mockMkdirSync(...args),
  };
});

jest.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

jest.mock('os', () => {
  const actual = jest.requireActual('os');
  return {
    ...actual,
    homedir: (...args: any[]) => mockHomedir(...args),
    platform: (...args: any[]) => mockPlatform(...args),
  };
});

jest.mock('@/lib/debug', () => ({
  debug: (...args: any[]) => mockDebug(...args),
}));

jest.mock('@/lib/config/statePaths.js', () => ({
  projectDataDir: (...args: any[]) => mockProjectDataDir(...args),
}));

jest.mock('@/lib/config/index', () => ({
  loadConfigSync: (...args: any[]) => mockLoadConfigSync(...args),
}));

jest.mock('@/server/services/customAgentStore', () => ({
  getCustomAgents: (...args: any[]) => mockGetCustomAgents(...args),
}));

jest.mock('@/services/skills/parser', () => ({
  parseSkill: (...args: any[]) => mockParseSkill(...args),
}));

jest.mock('@/services/skills/runner', () => ({
  runSkillEval: (...args: any[]) => mockRunSkillEval(...args),
}));

jest.mock('@/services/skills/improver', () => ({
  proposeImprovement: (...args: any[]) => mockProposeImprovement(...args),
}));

jest.mock('@/services/skills/evalGenerator', () => ({
  generateEvals: (...args: any[]) => mockGenerateEvals(...args),
}));

jest.mock('@/services/connectors/server', () => ({
  connectorRegistry: { name: 'mock-registry' },
}));

import express, { Application } from 'express';
const request = require('supertest');
import skillsRouter from '@/server/routes/skills';

const cwd = process.cwd();
const projectDataRoot = '/tmp/agent-health-data';
const skillEvalsRoot = join(projectDataRoot, 'skill-evals');
const uploadedSkillsRoot = join(projectDataRoot, 'uploaded-skills');

function dirent(name: string, isDirectory = true) {
  return {
    name,
    isDirectory: () => isDirectory,
  };
}

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use(skillsRouter);
  return app;
}

function setFsState({
  existingPaths = [],
  dirEntries = {},
  fileContents = {},
  readdirErrors = {},
}: {
  existingPaths?: string[];
  dirEntries?: Record<string, any>;
  fileContents?: Record<string, string>;
  readdirErrors?: Record<string, Error>;
}) {
  const existing = new Set(existingPaths);
  mockExistsSync.mockImplementation((path: string) => existing.has(String(path)));
  mockReaddirSync.mockImplementation((path: string) => {
    const key = String(path);
    if (readdirErrors[key]) {
      throw readdirErrors[key];
    }
    if (!(key in dirEntries)) {
      throw new Error(`ENOENT: ${key}`);
    }
    return dirEntries[key];
  });
  mockReadFileSync.mockImplementation((path: string) => {
    const key = String(path);
    if (!(key in fileContents)) {
      throw new Error(`ENOENT: ${key}`);
    }
    return fileContents[key];
  });
}

describe('Skills router', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockHomedir.mockReturnValue('/home/tester');
    mockPlatform.mockReturnValue('linux');
    mockExecSync.mockReturnValue('/picked/skill\n');
    mockLoadConfigSync.mockReturnValue({
      agents: [
        { key: 'claude', name: 'Claude', connectorType: 'claude-code' },
        { key: 'codex', name: 'Codex', connectorType: 'codex' },
      ],
      models: {
        demo: { model_id: 'mock://demo' },
        bedrock: { model_id: 'bedrock-model-id' },
      },
    });
    mockGetCustomAgents.mockReturnValue([]);
    mockGenerateEvals.mockResolvedValue({ evals: [{ id: 'eval-1' }] });
    mockRunSkillEval.mockResolvedValue({ iteration: 1, score: 0.9 });
    mockProposeImprovement.mockResolvedValue({
      originalInstructions: 'ORIGINAL',
      improvedInstructions: 'IMPROVED',
      changesDescription: 'Tightened examples',
      reasoning: 'Failed edge case',
    });
    setFsState({});
    app = makeApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('GET /api/skills/discover', () => {
    it('discovers valid skills from user and project locations and skips unreadable directories', async () => {
      const userSkillsDir = join('/home/tester', '.claude', 'skills');
      const repoSkillsDir = join(cwd, '.claude', 'skills');
      const kiroSkillsDir = join(cwd, '.kiro', 'skills');
      const projectSkillsDir = join(cwd, 'skills');
      const userSkill = join(userSkillsDir, 'user-skill');
      const repoSkill = join(repoSkillsDir, 'repo-skill');
      const invalidSkill = join(projectSkillsDir, 'broken-skill');

      setFsState({
        existingPaths: [
          userSkillsDir,
          userSkill,
          join(userSkill, 'SKILL.md'),
          repoSkillsDir,
          repoSkill,
          join(repoSkill, 'SKILL.md'),
          kiroSkillsDir,
          projectSkillsDir,
          invalidSkill,
          join(invalidSkill, 'SKILL.md'),
        ],
        dirEntries: {
          [userSkillsDir]: [dirent('user-skill')],
          [repoSkillsDir]: [dirent('repo-skill')],
          [projectSkillsDir]: [dirent('broken-skill')],
        },
        readdirErrors: {
          [kiroSkillsDir]: new Error('permission denied'),
        },
      });

      mockParseSkill.mockImplementation((skillDir: string) => {
        if (skillDir === userSkill) {
          return {
            valid: true,
            skill: { metadata: { name: 'User Skill', description: 'From user scope' } },
          };
        }
        if (skillDir === repoSkill) {
          return {
            valid: true,
            skill: { metadata: { name: 'Repo Skill', description: 'From project scope' } },
          };
        }
        return { valid: false, errors: ['broken'] };
      });

      const res = await request(app).get('/api/skills/discover');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        skills: [
          {
            path: '~/.claude/skills/user-skill',
            name: 'User Skill',
            description: 'From user scope',
            source: 'Claude Code (user)',
          },
          {
            path: '.claude/skills/repo-skill',
            name: 'Repo Skill',
            description: 'From project scope',
            source: 'Claude Code',
          },
        ],
      });
    });
  });

  describe('POST /api/skills/upload', () => {
    it('returns 400 when content is missing', async () => {
      const res = await request(app).post('/api/skills/upload').send({ fileName: 'SKILL.md' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'content is required (SKILL.md text)' });
    });

    it('writes uploaded SKILL.md and evals.json into the managed workspace', async () => {
      const res = await request(app).post('/api/skills/upload').send({
        fileName: 'Fancy Skill.md',
        content: 'name: Fancy Skill\n\nDo the thing',
        evalsContent: '[{"id":"eval-1"}]',
      });

      const uploadDir = join(uploadedSkillsRoot, 'fancy-skill');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ path: uploadDir, skillName: 'fancy-skill' });
      expect(mockMkdirSync).toHaveBeenCalledWith(uploadDir, { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(join(uploadDir, 'SKILL.md'), 'name: Fancy Skill\n\nDo the thing', 'utf-8');
      expect(mockMkdirSync).toHaveBeenCalledWith(join(uploadDir, 'evals'), { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(join(uploadDir, 'evals', 'evals.json'), '[{"id":"eval-1"}]', 'utf-8');
    });
  });

  describe('POST /api/skills/browse', () => {
    it('returns a selected path on linux', async () => {
      mockPlatform.mockReturnValueOnce('linux');
      mockExecSync.mockReturnValueOnce('/picked/skill\n');

      const res = await request(app).post('/api/skills/browse');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cancelled: false, path: '/picked/skill' });
    });

    it('trims the trailing slash on darwin', async () => {
      mockPlatform.mockReturnValueOnce('darwin');
      mockExecSync.mockReturnValueOnce('/Users/test/skill/\n');

      const res = await request(app).post('/api/skills/browse');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cancelled: false, path: '/Users/test/skill' });
    });

    it('supports the windows picker path', async () => {
      mockPlatform.mockReturnValueOnce('win32');
      mockExecSync.mockReturnValueOnce('C:\\Skills\\One\r\n');

      const res = await request(app).post('/api/skills/browse');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cancelled: false, path: 'C:\\Skills\\One' });
    });

    it('returns cancelled=true when the picker is cancelled', async () => {
      mockExecSync.mockImplementationOnce(() => {
        const error: any = new Error('User canceled');
        error.status = 1;
        throw error;
      });

      const res = await request(app).post('/api/skills/browse');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cancelled: true, path: null });
    });

    it('returns 501 without leaking the shell command when the picker fails unexpectedly (regression: F6 API KPI probe finding)', async () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error(
          "Command failed: zenity --file-selection --directory --title=\"Select a skill folder\" 2>/dev/null || kdialog --getexistingdirectory ~ 2>/dev/null\n/bin/sh: zenity: command not found"
        );
      });

      const res = await request(app).post('/api/skills/browse');

      expect(res.status).toBe(501);
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('zenity');
      expect(serialized).not.toContain('kdialog');
      expect(serialized).not.toContain('Command failed');
      expect(res.body.error).toMatch(/manually/i);
    });
  });

  describe('POST /api/skills/validate', () => {
    it('returns 400 when the skill path is missing', async () => {
      const res = await request(app).post('/api/skills/validate').send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'path is required' });
    });

    it('returns the parser result for a resolved path', async () => {
      const parsed = { valid: true, skill: { metadata: { name: 'Repo Skill' } }, errors: [] };
      mockParseSkill.mockReturnValueOnce(parsed);

      const res = await request(app).post('/api/skills/validate').send({ path: 'skills/repo-skill' });

      expect(res.status).toBe(200);
      expect(mockParseSkill).toHaveBeenCalledWith(resolve(cwd, 'skills/repo-skill'));
      expect(res.body).toEqual(parsed);
    });

    // Regression: GET /api/skills/discover returns user-scope skills with a
    // `~/.claude/skills/<name>` display path. resolveSkillPath() used to
    // resolve that against cwd, so validating any user-scope skill failed
    // with "Directory does not exist: <cwd>/~/.claude/skills/<name>".
    it('expands a ~/ display path against the home directory, not cwd', async () => {
      const parsed = { valid: true, skill: { metadata: { name: 'User Skill' } }, errors: [] };
      mockParseSkill.mockReturnValueOnce(parsed);

      const res = await request(app).post('/api/skills/validate').send({ path: '~/.claude/skills/user-skill' });

      expect(res.status).toBe(200);
      expect(mockParseSkill).toHaveBeenCalledWith(resolve('/home/tester', '.claude/skills/user-skill'));
    });

    it('expands the Windows-style ~\\ display path too (discover joins with the platform separator)', async () => {
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: { metadata: { name: 'x' } }, errors: [] });

      await request(app).post('/api/skills/validate').send({ path: '~\\.claude\\skills\\user-skill' });

      // The `~\` prefix is replaced by the home dir; the remainder is handed
      // to path.resolve as-is (this suite runs on POSIX, which does not
      // rewrite backslashes — on Windows it would).
      expect(mockParseSkill).toHaveBeenCalledWith(resolve('/home/tester', '.claude\\skills\\user-skill'));
    });

    it('does NOT expand a ~-prefixed relative directory name (e.g. ~backup/)', async () => {
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: { metadata: { name: 'x' } }, errors: [] });

      await request(app).post('/api/skills/validate').send({ path: '~backup/skill' });

      expect(mockParseSkill).toHaveBeenCalledWith(resolve(cwd, '~backup/skill'));
    });
  });

  describe('POST /api/skills/eval', () => {
    const skillPath = 'skills/repo-skill';
    const absoluteSkillPath = resolve(cwd, skillPath);
    const validSkill = {
      metadata: { name: 'repo-skill', description: 'Skill description' },
      instructions: 'ORIGINAL',
    };

    it('returns 400 when the path is missing', async () => {
      const res = await request(app).post('/api/skills/eval').send({});

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'path is required' });
    });

    it('returns 400 for an invalid skill', async () => {
      mockParseSkill.mockReturnValueOnce({ valid: false, skill: null, errors: ['invalid'] });

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid skill', details: ['invalid'] });
    });

    it('returns 400 when the requested agent is not found', async () => {
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: validSkill, evalsFile: { evals: [{ id: 'eval-1' }] } });

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath, agentKey: 'missing-agent' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Agent not found: missing-agent' });
    });

    it('returns 400 when no agents are configured', async () => {
      mockLoadConfigSync.mockReturnValueOnce({ agents: [], models: { bedrock: { model_id: 'bedrock-model-id' } } });
      mockGetCustomAgents.mockReturnValueOnce([]);
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: validSkill, evalsFile: { evals: [{ id: 'eval-1' }] } });

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'No agents configured' });
    });

    it('returns 500 when eval generation fails', async () => {
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: validSkill, evalsFile: { evals: [] } });
      mockGenerateEvals.mockRejectedValueOnce(new Error('generation failed'));

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: 'Failed to generate eval cases',
        details: 'generation failed',
      });
    });

    it('streams progress and completion when evaluation succeeds without failures', async () => {
      const workspacePath = join(skillEvalsRoot, 'repo-skill');
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: validSkill, evalsFile: undefined });
      setFsState({
        existingPaths: [],
      });
      mockRunSkillEval.mockImplementationOnce(async ({ onProgress, agent, modelId, serverBaseUrl }: any) => {
        expect(agent.key).toBe('claude');
        expect(modelId).toBe('bedrock-model-id');
        expect(serverBaseUrl).toMatch(/^http:\/\/localhost:\d+$/);
        onProgress({ type: 'eval_running', current: 1, total: 1 });
        return { iteration: 1, score: 0.9, workspacePath };
      });

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('"type":"eval_running"');
      expect(res.text).toContain('"type":"completed"');
      expect(mockGenerateEvals).toHaveBeenCalledWith(
        validSkill,
        expect.stringMatching(/^http:\/\/localhost:\d+$/),
        'bedrock-model-id'
      );
    });

    it('writes an improvement proposal and emits improved=false when failures exist', async () => {
      const workspacePath = join(skillEvalsRoot, 'repo-skill');
      const iterationDir = join(workspacePath, 'iteration-8');
      const withSkillPath = join(iterationDir, 'eval-eval-1', 'with_skill', 'grading.json');
      const withoutSkillPath = join(iterationDir, 'eval-eval-1', 'without_skill', 'grading.json');
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: validSkill, evalsFile: { evals: [{ id: 'eval-1' }] } });
      setFsState({
        existingPaths: [workspacePath, withSkillPath, withoutSkillPath],
        dirEntries: {
          [workspacePath]: ['iteration-2', 'iteration-7'],
        },
        fileContents: {
          [withSkillPath]: JSON.stringify({ summary: { pass_rate: 0.5 } }),
          [withoutSkillPath]: JSON.stringify({ summary: { pass_rate: 0.7 } }),
        },
      });
      mockRunSkillEval.mockImplementationOnce(async ({ onProgress }: any) => {
        onProgress({ type: 'eval_done', completed: 1 });
        return { iteration: 8, score: 0.4 };
      });

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath, auto: false, modelId: 'bedrock' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"improving"');
      expect(res.text).toContain('"type":"improved"');
      expect(res.text).toContain('"applied":false');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        join(iterationDir, 'improvement-proposal.json'),
        JSON.stringify(
          {
            originalInstructions: 'ORIGINAL',
            improvedInstructions: 'IMPROVED',
            changesDescription: 'Tightened examples',
            reasoning: 'Failed edge case',
          },
          null,
          2
        )
      );
      expect(mockProposeImprovement).toHaveBeenCalledWith({
        skill: validSkill,
        withSkillGradings: [{ summary: { pass_rate: 0.5 } }],
        withoutSkillGradings: [{ summary: { pass_rate: 0.7 } }],
        benchmark: { iteration: 8, score: 0.4 },
        serverBaseUrl: expect.stringMatching(/^http:\/\/localhost:\d+$/),
        modelId: 'bedrock-model-id',
      });
    });

    it('auto-applies an improvement when requested', async () => {
      const iterationDir = join(skillEvalsRoot, 'repo-skill', 'iteration-1');
      const withSkillPath = join(iterationDir, 'eval-eval-1', 'with_skill', 'grading.json');
      const skillMdPath = join(absoluteSkillPath, 'SKILL.md');
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: validSkill, evalsFile: { evals: [{ id: 'eval-1' }] } });
      setFsState({
        existingPaths: [withSkillPath, skillMdPath],
        fileContents: {
          [withSkillPath]: JSON.stringify({ summary: { pass_rate: 0.2 } }),
          [skillMdPath]: '# Skill\n\nORIGINAL\n',
        },
      });

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath, auto: true });

      expect(res.status).toBe(200);
      expect(mockCopyFileSync).toHaveBeenCalledWith(skillMdPath, `${skillMdPath}.bak`);
      expect(mockWriteFileSync).toHaveBeenCalledWith(skillMdPath, '# Skill\n\nIMPROVED\n');
      expect(res.text).toContain('"applied":true');
    });

    it('streams an error event when evaluation throws after SSE starts', async () => {
      mockParseSkill.mockReturnValueOnce({ valid: true, skill: validSkill, evalsFile: { evals: [{ id: 'eval-1' }] } });
      mockRunSkillEval.mockRejectedValueOnce(new Error('eval crashed'));

      const res = await request(app).post('/api/skills/eval').send({ path: skillPath });

      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"error"');
      expect(res.text).toContain('eval crashed');
    });
  });

  describe('GET /api/skills/results', () => {
    it('returns 400 when workspace is missing', async () => {
      const res = await request(app).get('/api/skills/results');

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'workspace query parameter is required' });
    });

    it('returns 404 when the workspace does not exist', async () => {
      setFsState({ existingPaths: [] });

      const res = await request(app).get('/api/skills/results?workspace=missing-skill');

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Workspace not found: missing-skill' });
    });

    it('returns sorted iterations and normalized proposals', async () => {
      const workspacePath = join(skillEvalsRoot, 'repo-skill');
      const iteration1Benchmark = join(workspacePath, 'iteration-1', 'benchmark.json');
      const iteration2Benchmark = join(workspacePath, 'iteration-2', 'benchmark.json');
      const iteration1Proposal = join(workspacePath, 'iteration-1', 'improvement-proposal.json');
      const iteration2Proposal = join(workspacePath, 'iteration-2', 'improvement-proposal.json');

      setFsState({
        existingPaths: [workspacePath, iteration1Benchmark, iteration2Benchmark, iteration1Proposal, iteration2Proposal],
        dirEntries: {
          [workspacePath]: [dirent('iteration-2'), dirent('notes', false), dirent('iteration-1')],
        },
        fileContents: {
          [iteration1Benchmark]: JSON.stringify({ iteration: 1, score: 0.7 }),
          [iteration2Benchmark]: JSON.stringify({ iteration: 2, score: 0.9 }),
          [iteration1Proposal]: JSON.stringify({
            changesDescription: 'Improve examples',
            reasoning: 'Iteration 1 failures',
            improvedInstructions: 'UPDATED',
          }),
          [iteration2Proposal]: '{bad json',
        },
      });

      const res = await request(app).get('/api/skills/results?workspace=.agent-health/data/skill-evals/repo-skill');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        iterations: [
          { iteration: 1, score: 0.7 },
          { iteration: 2, score: 0.9 },
        ],
        proposals: {
          1: {
            applied: false,
            changes: 'Improve examples',
            reasoning: 'Iteration 1 failures',
            improvedInstructions: 'UPDATED',
          },
        },
      });
    });

    it('returns 500 when reading the workspace fails', async () => {
      const workspacePath = join(skillEvalsRoot, 'repo-skill');
      setFsState({
        existingPaths: [workspacePath],
        readdirErrors: {
          [workspacePath]: new Error('disk error'),
        },
      });

      const res = await request(app).get('/api/skills/results?workspace=repo-skill');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Failed to read workspace: Error: disk error' });
    });
  });
});
