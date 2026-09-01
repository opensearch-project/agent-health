/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skills Routes - Evaluate and improve AgentSkills
 */

import { Router, Request, Response } from 'express';
import { resolve } from 'path';
import { existsSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { homedir, platform } from 'os';
import { debug } from '@/lib/debug';
import { projectDataDir } from '@/lib/config/statePaths.js';
import { loadConfigSync } from '@/lib/config/index';
import { getCustomAgents } from '@/server/services/customAgentStore';
import { parseSkill } from '@/services/skills/parser';
import { runSkillEval } from '@/services/skills/runner';
import { proposeImprovement } from '@/services/skills/improver';
import { generateEvals } from '@/services/skills/evalGenerator';
import { connectorRegistry } from '@/connectors/server';
import type { SkillEvalProgressEvent, SkillBenchmarkResult, SkillGradingResult } from '@/types';

const router = Router();

/**
 * Resolve a skill path to an absolute path.
 * Accepts relative paths (resolved against cwd) or absolute paths.
 * This is a local dev tool — the server process already has filesystem access,
 * so there's no security benefit in restricting paths.
 */
function resolveSkillPath(inputPath: string): string {
  const cwd = process.cwd();
  return resolve(cwd, inputPath);
}

/** Managed workspace root for skill evaluation results */
const SKILL_EVALS_ROOT = join(projectDataDir(), 'skill-evals');

/**
 * GET /api/skills/discover
 * Scan common locations for SKILL.md files and return available skills.
 */
router.get('/api/skills/discover', async (_req: Request, res: Response) => {
  const cwd = process.cwd();
  const home = homedir();
  const skills: { path: string; name: string; description: string; source: string }[] = [];

  // Per Claude Code spec, skills exist at *both* user scope (~/.claude/skills)
  // and project scope (<cwd>/.claude/skills). User-scope skills are visible
  // across all projects; project-scope skills are repo-local. We surface both,
  // labelling the source so the UI can disambiguate.
  const scanDirs: { dir: string; source: string }[] = [
    { dir: join(home, '.claude', 'skills'), source: 'Claude Code (user)' },
    { dir: join(cwd, '.claude', 'skills'), source: 'Claude Code' },
    { dir: join(cwd, '.kiro', 'skills'), source: 'Kiro' },
    { dir: join(cwd, '.kiro', 'steering'), source: 'Kiro' },
    { dir: join(cwd, '.codex'), source: 'Codex' },
    { dir: join(cwd, '.cursor', 'rules'), source: 'Cursor' },
    { dir: join(cwd, '.github', 'copilot'), source: 'Copilot' },
    { dir: join(cwd, '.continue', 'skills'), source: 'Continue' },
    { dir: join(cwd, 'skills'), source: 'Project' },
  ];

  // Dedupe by absolute skill path so a symlinked or duplicated skill
  // does not appear twice in the dropdown.
  const seen = new Set<string>();

  for (const { dir, source } of scanDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillDir = join(dir, entry.name);
        const skillMd = join(skillDir, 'SKILL.md');
        if (!existsSync(skillMd)) continue;

        const result = parseSkill(skillDir);
        if (result.valid && result.skill) {
          const absSkillDir = resolve(skillDir);
          if (seen.has(absSkillDir)) continue;
          seen.add(absSkillDir);

          // Display path: relative to cwd if inside the project, else use ~/ shorthand
          // for home-relative paths so the dropdown stays scannable.
          let displayPath = absSkillDir;
          if (absSkillDir.startsWith(cwd + '/') || absSkillDir === cwd) {
            displayPath = absSkillDir.slice(cwd.length + 1) || '.';
          } else if (absSkillDir.startsWith(home + '/')) {
            displayPath = '~' + absSkillDir.slice(home.length);
          }
          skills.push({
            path: displayPath,
            name: result.skill.metadata.name,
            description: result.skill.metadata.description,
            source,
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  res.json({ skills });
});

/**
 * POST /api/skills/upload
 * Accept a SKILL.md file (and optional evals.json) as text content,
 * save to a managed directory, and return the path for validation/eval.
 */
router.post('/api/skills/upload', async (req: Request, res: Response) => {
  const { fileName, content, evalsContent } = req.body;

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required (SKILL.md text)' });
  }

  const { mkdirSync, writeFileSync } = await import('fs');

  // Derive skill name from frontmatter or filename
  const nameMatch = content.match(/^name:\s*(.+)$/m);
  const skillName = nameMatch ? nameMatch[1].trim() : (fileName || 'uploaded-skill').replace(/\.md$/i, '');
  const safeDir = skillName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();

  const uploadDir = join(projectDataDir(), 'uploaded-skills', safeDir);
  mkdirSync(uploadDir, { recursive: true });
  writeFileSync(join(uploadDir, 'SKILL.md'), content, 'utf-8');

  if (evalsContent) {
    const evalsDir = join(uploadDir, 'evals');
    mkdirSync(evalsDir, { recursive: true });
    writeFileSync(join(evalsDir, 'evals.json'), evalsContent, 'utf-8');
  }

  debug('SkillsAPI', 'Uploaded skill to:', uploadDir);
  res.json({ path: uploadDir, skillName: safeDir });
});

/**
 * POST /api/skills/browse
 * Open native OS folder picker dialog and return the selected path.
 */
router.post('/api/skills/browse', async (_req: Request, res: Response) => {
  try {
    let selectedPath: string | null = null;

    if (platform() === 'darwin') {
      const result = execSync(
        `osascript -e 'POSIX path of (choose folder with prompt "Select a skill folder")'`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
      if (result) selectedPath = result.replace(/\/$/, '');
    } else if (platform() === 'linux') {
      const result = execSync(
        `zenity --file-selection --directory --title="Select a skill folder" 2>/dev/null || kdialog --getexistingdirectory ~ 2>/dev/null`,
        { encoding: 'utf-8', timeout: 60000 }
      ).trim();
      if (result) selectedPath = result;
    } else {
      // Windows - PowerShell folder browser
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Select a skill folder'; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }`;
      const result = execSync(`powershell -Command "${ps}"`, { encoding: 'utf-8', timeout: 60000 }).trim();
      if (result) selectedPath = result;
    }

    if (!selectedPath) {
      return res.json({ cancelled: true, path: null });
    }

    res.json({ cancelled: false, path: selectedPath });
  } catch (err: any) {
    if (err.status === 1 || err.message?.includes('User canceled')) {
      return res.json({ cancelled: true, path: null });
    }
    res.status(500).json({ error: `Failed to open folder picker: ${err.message}` });
  }
});

/**
 * POST /api/skills/validate
 * Validate a skill directory (SKILL.md + optional evals.json)
 */
router.post('/api/skills/validate', async (req: Request, res: Response) => {
  const { path: skillPath } = req.body;

  if (!skillPath || typeof skillPath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }

  const absolutePath = resolveSkillPath(skillPath);
  debug('SkillsAPI', 'Validating skill at:', absolutePath);

  const result = parseSkill(absolutePath);
  res.json(result);
});

/**
 * POST /api/skills/eval
 * Run full skill evaluation + improvement cycle. Streams progress via SSE.
 *
 * Body: {
 *   path: string,
 *   agentKey?: string,
 *   modelId?: string,
 *   auto?: boolean       // Auto-apply improvements without confirmation
 * }
 *
 * SSE events: started → eval_running → eval_grading → eval_done → improvement → completed
 */
router.post('/api/skills/eval', async (req: Request, res: Response) => {
  const { path: skillPath, agentKey, modelId, auto } = req.body;

  if (!skillPath || typeof skillPath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }

  const absolutePath = resolveSkillPath(skillPath);

  // Validate skill
  const validation = parseSkill(absolutePath);
  if (!validation.valid || !validation.skill) {
    return res.status(400).json({ error: 'Invalid skill', details: validation.errors });
  }

  // Resolve agent
  const config = loadConfigSync();
  const allAgents = [...config.agents, ...getCustomAgents()];

  let agent;
  if (agentKey) {
    agent = allAgents.find(a => a.key === agentKey || a.name.toLowerCase() === agentKey.toLowerCase());
    if (!agent) {
      return res.status(400).json({ error: `Agent not found: ${agentKey}` });
    }
  } else {
    agent = allAgents.find(a => a.connectorType === 'claude-code') || allAgents[0];
  }

  if (!agent) {
    return res.status(400).json({ error: 'No agents configured' });
  }

  // Resolve model — skip mock/demo models, resolve to Bedrock model_id
  const modelKey = modelId || Object.keys(config.models).find(
    k => !config.models[k].model_id.startsWith('mock://')
  ) || 'claude-sonnet';
  const effectiveModelId = config.models[modelKey]?.model_id || modelKey;

  // Determine server base URL for judge/generation calls
  const port = req.socket.localPort || 4001;
  const serverBaseUrl = `http://localhost:${port}`;

  // Generate evals if none exist
  let evalsFile = validation.evalsFile;
  if (!evalsFile || evalsFile.evals.length === 0) {
    debug('SkillsAPI', 'No evals found, generating...');

    // Can't use SSE yet for the generation step — return error asking to retry
    // Actually, let's generate inline and continue
    try {
      evalsFile = await generateEvals(validation.skill, serverBaseUrl, effectiveModelId);
    } catch (err) {
      return res.status(500).json({
        error: 'Failed to generate eval cases',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Determine workspace and iteration
  const workspacePath = join(projectDataDir(), 'skill-evals', validation.skill.metadata.name);
  const iteration = getNextIteration(workspacePath);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering for nginx/ALB-style intermediaries that hold SSE
  // bytes in a buffer until the response ends. Without this, even active
  // 'data:' frames may not reach the browser until res.end() fires.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Keepalive heartbeat. Each per-eval agent run takes 60–200s with no
  // outbound SSE traffic, which trips intermediate-proxy idle timeouts and
  // EventSource-style readers — the stream silently dies and the client
  // sees no 'completed' event despite the server finishing successfully
  // (benchmark.json + improvement-proposal.json land on disk).
  //
  // SSE comment lines (':' prefix) are ignored by the EventSource parser
  // but reset every proxy idle timer along the way. 15s is well below
  // typical 30–60s defaults.
  let keepaliveActive = true;
  const keepaliveTimer = setInterval(() => {
    if (!keepaliveActive) return;
    try {
      res.write(': keepalive\n\n');
    } catch {
      // Underlying socket is gone — stop trying so we don't spam errors.
      keepaliveActive = false;
      clearInterval(keepaliveTimer);
    }
  }, 15_000);
  const stopKeepalive = () => {
    keepaliveActive = false;
    clearInterval(keepaliveTimer);
  };
  // If the client closes the connection mid-run, stop the timer immediately.
  // The eval itself keeps running on the server (writes benchmark.json /
  // improvement-proposal.json to disk for recovery on next page load).
  req.on('close', stopKeepalive);

  const sendEvent = (event: SkillEvalProgressEvent) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // Client gone; let the run finish so disk artifacts are intact.
      stopKeepalive();
    }
  };

  try {
    // Step 1: Run A/B evaluation
    const benchmark = await runSkillEval({
      skill: validation.skill,
      evals: evalsFile,
      agent,
      modelId: effectiveModelId,
      workspacePath,
      iteration,
      registry: connectorRegistry,
      serverBaseUrl,
      onProgress: sendEvent,
    });

    // Step 2: Propose improvement (if there are failures)
    const iterationDir = join(workspacePath, `iteration-${iteration}`);
    const { withSkillGradings, withoutSkillGradings } = loadGradings(iterationDir, evalsFile.evals.map(e => e.id));

    const hasFailures = withSkillGradings.some(g => g.summary.pass_rate < 1);

    if (hasFailures) {
      sendEvent({ type: 'improving', message: 'Analyzing failures and proposing improvements...' });

      const proposal = await proposeImprovement({
        skill: validation.skill,
        withSkillGradings,
        withoutSkillGradings,
        benchmark,
        serverBaseUrl,
        modelId: effectiveModelId,
      });

      // Write proposal to workspace
      writeFileSync(
        join(iterationDir, 'improvement-proposal.json'),
        JSON.stringify(proposal, null, 2)
      );

      if (auto && proposal.improvedInstructions !== proposal.originalInstructions) {
        // Auto-apply: write improved SKILL.md, but reversibly.
        //
        // Skills authoring principle: don't surprise the user with destructive
        // writes. We:
        //   1. Write a `.bak` snapshot of the original alongside the file, so
        //      the user can restore even if they don't have it under VCS.
        //   2. Guard against the silent no-op case where the original
        //      instructions text doesn't appear verbatim in the file (e.g.
        //      whitespace mismatch after CRLF normalisation). Without this
        //      guard, `String.replace` returns the unchanged file and we'd
        //      claim "applied" while nothing changed.
        const skillMdPath = join(absolutePath, 'SKILL.md');
        const backupPath = `${skillMdPath}.bak`;
        const original = readFileSync(skillMdPath, 'utf-8');

        if (!original.includes(proposal.originalInstructions)) {
          throw new Error(
            `Cannot auto-apply: the original instructions snapshot does not match the current SKILL.md content ` +
            `(file may have been edited since the proposal was generated). The proposal is preserved at ` +
            `${join(iterationDir, 'improvement-proposal.json')} — review and apply manually.`,
          );
        }

        // Snapshot first, then write. If the write fails halfway, the .bak still has the original.
        copyFileSync(skillMdPath, backupPath);
        const updated = original.replace(proposal.originalInstructions, proposal.improvedInstructions);
        writeFileSync(skillMdPath, updated);

        sendEvent({
          type: 'improved',
          applied: true,
          changes: proposal.changesDescription,
          reasoning: proposal.reasoning,
        });
      } else {
        sendEvent({
          type: 'improved',
          applied: false,
          changes: proposal.changesDescription,
          reasoning: proposal.reasoning,
          improvedInstructions: proposal.improvedInstructions,
        });
      }
    }

    sendEvent({ type: 'completed', benchmark });
    stopKeepalive();
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendEvent({ type: 'error', message });
    stopKeepalive();
    res.end();
  }
});

/**
 * GET /api/skills/results
 * Read benchmark results from a workspace directory.
 */
router.get('/api/skills/results', async (req: Request, res: Response) => {
  const workspace = req.query.workspace as string;

  if (!workspace) {
    return res.status(400).json({ error: 'workspace query parameter is required' });
  }

  // Resolve workspace path. Accept any of:
  //   - bare skill name              "add-connector"
  //   - prefixed path                  ".agent-health/data/skill-evals/add-connector"
  //   - absolute path                  "/abs/path/to/workspace"
  // The frontend has historically built the prefixed form, while CLI / API
  // callers tend to pass the bare name. Normalise here so both work.
  const NEW_PREFIX = '.agent-health/data/skill-evals/';
  const normalised = workspace.startsWith(NEW_PREFIX)
    ? workspace.slice(NEW_PREFIX.length)
    : workspace;
  const absolutePath = resolve(SKILL_EVALS_ROOT, normalised);
  if (!existsSync(absolutePath)) {
    return res.status(404).json({ error: `Workspace not found: ${workspace}` });
  }

  // Pair each iteration's benchmark with its improvement-proposal (if present).
  // Returning them together lets the UI populate Results / Improvement / History
  // tabs immediately when re-opening a previously-evaluated skill, instead of
  // requiring a fresh run to surface past evidence.
  const iterations: SkillBenchmarkResult[] = [];
  const proposals: Record<number, {
    applied: boolean;
    changes: string;
    reasoning: string;
    improvedInstructions?: string;
  }> = {};

  try {
    const entries = readdirSync(absolutePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('iteration-')) continue;
      const benchmarkPath = resolve(absolutePath, entry.name, 'benchmark.json');
      if (!existsSync(benchmarkPath)) continue;
      const benchmark: SkillBenchmarkResult = JSON.parse(readFileSync(benchmarkPath, 'utf-8'));
      iterations.push(benchmark);

      const proposalPath = resolve(absolutePath, entry.name, 'improvement-proposal.json');
      if (existsSync(proposalPath)) {
        try {
          const proposal = JSON.parse(readFileSync(proposalPath, 'utf-8'));
          // Normalise to the wire-format the SSE 'improved' event uses
          // ('changes' rather than 'changesDescription'), so the frontend
          // doesn't need a parallel state shape for past vs. live proposals.
          proposals[benchmark.iteration] = {
            applied: false,
            changes: proposal.changesDescription ?? '',
            reasoning: proposal.reasoning ?? '',
            improvedInstructions: proposal.improvedInstructions,
          };
        } catch {
          // Proposal exists but is malformed — skip silently; the
          // benchmark is still useful for the Results / History tabs.
        }
      }
    }
  } catch (err) {
    return res.status(500).json({ error: `Failed to read workspace: ${err}` });
  }

  iterations.sort((a, b) => a.iteration - b.iteration);
  res.json({ iterations, proposals });
});

/**
 * Load grading results from an iteration directory.
 */
function loadGradings(iterationDir: string, evalIds: (string | number)[]): {
  withSkillGradings: SkillGradingResult[];
  withoutSkillGradings: SkillGradingResult[];
} {
  const withSkillGradings: SkillGradingResult[] = [];
  const withoutSkillGradings: SkillGradingResult[] = [];

  for (const id of evalIds) {
    const evalDir = join(iterationDir, `eval-${id}`);

    const withPath = join(evalDir, 'with_skill', 'grading.json');
    if (existsSync(withPath)) {
      withSkillGradings.push(JSON.parse(readFileSync(withPath, 'utf-8')));
    }

    const withoutPath = join(evalDir, 'without_skill', 'grading.json');
    if (existsSync(withoutPath)) {
      withoutSkillGradings.push(JSON.parse(readFileSync(withoutPath, 'utf-8')));
    }
  }

  return { withSkillGradings, withoutSkillGradings };
}

/**
 * Determine the next iteration number for a workspace.
 */
function getNextIteration(workspacePath: string): number {
  if (!existsSync(workspacePath)) return 1;

  try {
    const entries = readdirSync(workspacePath);
    const iterations = entries
      .filter(e => e.startsWith('iteration-'))
      .map(e => parseInt(e.replace('iteration-', ''), 10))
      .filter(n => !isNaN(n));

    return iterations.length > 0 ? Math.max(...iterations) + 1 : 1;
  } catch {
    return 1;
  }
}

export default router;
