/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Loader2, CheckCircle, XCircle, Play, Wand2, FolderOpen, ArrowUpCircle, ChevronRight, Folder, Scale, Upload, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { PREFS_KEYS } from '@/lib/preferences';
import { usePersistedState } from '@/hooks/usePersistedState';
import { discoverSkills, validateSkill, browseForSkillFolder, streamSkillEval, getSkillResults, uploadSkillFile } from '@/services/client/skillsApi';
import type { DiscoveredSkill } from '@/services/client/skillsApi';
import type { SkillValidationResult, SkillEvalProgressEvent, SkillBenchmarkResult } from '@/types';
import { useClusterContext } from '@/hooks/useClusterContext';
import { ClusterContextBanner } from '@/components/comparison/ClusterContextBanner';

type EvalPhase = 'idle' | 'validating' | 'running' | 'done' | 'error';

function PathBreadcrumb({ path }: { path: string }) {
  const segments = path.split('/').filter(Boolean);
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
      {segments.map((segment, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight className="h-3 w-3 flex-shrink-0" />}
          <span className={i === segments.length - 1 ? 'font-medium text-foreground flex items-center gap-1' : ''}>
            {i === segments.length - 1 && <Folder className="h-3 w-3 inline" />}
            {segment}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

export const SkillsPage: React.FC = () => {
  // Cluster context — when present, render a banner and let the user
  // know we've pre-loaded the failing scenario as the focus of their
  // skill iteration.
  const { context: clusterContext } = useClusterContext();

  // Config inputs
  const [skillPath, setSkillPath] = useState('');
  const [selectedAgent, setSelectedAgent] = usePersistedState<string>(PREFS_KEYS.agentKey, '');
  const [selectedModel, setSelectedModel] = usePersistedState<string>(PREFS_KEYS.modelId, '');
  const [showManualPath, setShowManualPath] = useState(false);
  const [manualPath, setManualPath] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Discovered skills
  const [availableSkills, setAvailableSkills] = useState<DiscoveredSkill[]>([]);
  const [loadingSkills, setLoadingSkills] = useState(true);

  // Validation
  const [validation, setValidation] = useState<SkillValidationResult | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Eval state
  const [evalPhase, setEvalPhase] = useState<EvalPhase>('idle');
  const [progressText, setProgressText] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [totalEvals, setTotalEvals] = useState(0);
  const [completedEvals, setCompletedEvals] = useState(0);
  // Per-eval outcomes accumulated during a run — surfaces 'errored' distinct
  // from 'failed' so the user can tell "agent crashed" from "skill missed".
  const [evalOutcomes, setEvalOutcomes] = useState<Array<{
    evalId: number;
    condition: 'with_skill' | 'without_skill';
    evalStatus: 'passed' | 'failed' | 'errored';
    errorMessage?: string;
  }>>([]);

  // Results
  const [benchmark, setBenchmark] = useState<SkillBenchmarkResult | null>(null);
  const [improvement, setImprovement] = useState<{
    applied: boolean;
    changes: string;
    reasoning: string;
    improvedInstructions?: string;
  } | null>(null);
  const [iterations, setIterations] = useState<SkillBenchmarkResult[]>([]);

  // Active tab
  const [activeTab, setActiveTab] = useState('skill');

  // Agents/models from config
  const agents = DEFAULT_CONFIG.agents;
  const models = Object.entries(DEFAULT_CONFIG.models).map(([key, cfg]) => ({ key, ...cfg }));

  // Discover skills on mount
  useEffect(() => {
    discoverSkills()
      .then(setAvailableSkills)
      .catch(() => setAvailableSkills([]))
      .finally(() => setLoadingSkills(false));
  }, []);

  // Set defaults only if no persisted preference exists
  useEffect(() => {
    if (!selectedAgent) {
      const claudeAgent = agents.find(a => a.connectorType === 'claude-code');
      if (claudeAgent) setSelectedAgent(claudeAgent.key);
    }
    if (!selectedModel) {
      const realModel = models.find(m => !m.model_id.startsWith('mock://'));
      if (realModel) setSelectedModel(realModel.key);
    }
  }, [agents.length, models.length]);

  const validateAndSelect = useCallback(async (path: string) => {
    setSkillPath(path);
    setValidation(null);
    setValidationError(null);
    setBenchmark(null);
    setImprovement(null);
    setEvalPhase('validating');
    try {
      const result = await validateSkill(path);
      setValidation(result);
      if (!result.valid) {
        setValidationError(result.errors.join('; '));
      }
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
      setValidation(null);
    } finally {
      setEvalPhase('idle');
    }
  }, []);

  const handleSkillSelect = useCallback((value: string) => {
    if (value === '__manual__') {
      setShowManualPath(true);
      return;
    }
    setShowManualPath(false);
    validateAndSelect(value);
  }, [validateAndSelect]);

  const handleManualPathSubmit = useCallback(() => {
    if (manualPath.trim()) {
      setShowManualPath(false);
      validateAndSelect(manualPath.trim());
    }
  }, [manualPath, validateAndSelect]);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      const { path } = await uploadSkillFile(content, file.name);
      validateAndSelect(path);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    }
    // Reset input so same file can be re-uploaded
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [validateAndSelect]);

  const handleBrowse = useCallback(async () => {
    try {
      const result = await browseForSkillFolder();
      if (!result.cancelled && result.path) {
        validateAndSelect(result.path);
      }
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : String(err));
    }
  }, [validateAndSelect]);

  const handleRunEval = useCallback(async (auto = false) => {
    if (!validation?.valid) return;
    setEvalPhase('running');
    setProgressText('Starting evaluation...');
    setProgressPercent(0);
    setCompletedEvals(0);
    setEvalOutcomes([]);
    setBenchmark(null);
    setImprovement(null);

    // Snapshot start time so the recovery probe can distinguish a stale
    // pre-existing iteration from one this run produced.
    const runStartedAt = Date.now();

    try {
      const result = await streamSkillEval(
        {
          path: skillPath.trim(),
          agentKey: selectedAgent || undefined,
          modelId: selectedModel || undefined,
          auto,
        },
        (event: SkillEvalProgressEvent) => {
          switch (event.type) {
            case 'started':
              setTotalEvals(event.totalEvals);
              setProgressText(`Evaluating "${event.skillName}" (${event.totalEvals} evals)`);
              break;
            case 'eval_running':
              setProgressText(`Eval #${event.evalId} [${event.condition}]: running agent...`);
              break;
            case 'eval_grading':
              setProgressText(`Eval #${event.evalId} [${event.condition}]: grading assertions...`);
              break;
            case 'eval_done':
              setCompletedEvals(prev => {
                const next = prev + 1;
                setProgressPercent(Math.round((next / (totalEvals * 2)) * 100));
                return next;
              });
              setEvalOutcomes(prev => [
                ...prev,
                {
                  evalId: event.evalId,
                  condition: event.condition,
                  evalStatus: event.evalStatus,
                  errorMessage: event.errorMessage,
                },
              ]);
              {
                const label = event.evalStatus === 'errored'
                  ? 'errored'
                  : `${Math.round(event.passRate * 100)}% pass rate`;
                setProgressText(`Eval #${event.evalId} [${event.condition}]: ${label}`);
              }
              break;
            case 'improving':
              setProgressText('Analyzing failures and proposing improvements...');
              setProgressPercent(90);
              break;
            case 'improved':
              setImprovement({
                applied: event.applied,
                changes: event.changes,
                reasoning: event.reasoning,
                improvedInstructions: event.improvedInstructions,
              });
              break;
          }
        },
      );

      setBenchmark(result.benchmark);
      if (result.improvement) setImprovement(result.improvement);
      setEvalPhase('done');
      setProgressPercent(100);
      setActiveTab('results');

      // Load history
      loadHistory();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Recovery probe. Long agent runs (60–200s with no SSE traffic)
      // sometimes lose the stream to proxy idle timeouts — the server
      // continues running and writes benchmark.json + improvement-proposal
      // to disk, but the client throws "Evaluation completed without
      // benchmark results" and the user thinks everything was lost.
      //
      // Before surfacing the error, ask the workspace whether a fresh
      // iteration landed since this run started. If it did, treat as
      // success and load that iteration's evidence into the UI.
      if (validation?.skill) {
        try {
          const workspace = `.agent-health/data/skill-evals/${validation.skill.metadata.name}`;
          const { iterations: iters, proposals } = await getSkillResults(workspace);
          const recovered = iters.find(it => Date.parse(it.created_at) >= runStartedAt);
          if (recovered) {
            setBenchmark(recovered);
            const recoveredProposal = proposals?.[recovered.iteration];
            if (recoveredProposal) setImprovement(recoveredProposal);
            setIterations(iters);
            setEvalPhase('done');
            setProgressPercent(100);
            setActiveTab('results');
            setProgressText(
              'Stream lost mid-run, but the server finished and the result was recovered from disk. ' +
              '(Original error: ' + message + ')',
            );
            return;
          }
        } catch {
          // Probe itself failed — fall through to the original error path.
        }
      }

      setEvalPhase('error');
      setProgressText(message);
    }
    // loadHistory is intentionally omitted from deps — it's declared below
    // (TDZ would error if listed) and its identity is stable across renders
    // for our purposes (it closes over `validation`, which is already in
    // the dep list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validation, skillPath, selectedAgent, selectedModel, totalEvals]);

  const loadHistory = useCallback(async () => {
    if (!validation?.skill) return;
    const workspace = `.agent-health/data/skill-evals/${validation.skill.metadata.name}`;
    try {
      const { iterations: iters, proposals } = await getSkillResults(workspace);
      setIterations(iters);
      // If there's prior history, prime the Results / Improvement tabs with
      // the most-recent iteration so users can view past evidence without
      // re-running the eval. New runs (handleRunEval) override these via
      // their own setBenchmark / setImprovement calls.
      if (iters.length > 0) {
        const latest = iters[iters.length - 1];
        setBenchmark(prev => prev ?? latest);
        const latestProposal = proposals?.[latest.iteration];
        if (latestProposal) {
          setImprovement(prev => prev ?? latestProposal);
        }
      }
    } catch {
      // Workspace might not exist yet — that's expected for first-time skills.
    }
  }, [validation]);

  // Auto-load history whenever validation transitions to a valid skill, so
  // the Results / Improvement / History tabs surface past iterations without
  // requiring a fresh run. The dependency on validation.skill.path means
  // switching between skills re-loads the right workspace.
  useEffect(() => {
    if (validation?.valid && validation.skill) {
      loadHistory();
    }
  }, [validation?.skill?.path, loadHistory]);

  const fmtPct = (n: number) => `${Math.round(n * 100)}%`;
  const fmtDelta = (n: number) => {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${Math.round(n * 100)}%`;
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl" data-testid="skills-page">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Wand2 className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold" data-testid="skills-title">Skills Evaluator</h1>
          <p className="text-sm text-muted-foreground">Evaluate and improve AgentSkills via A/B testing</p>
        </div>
        <Badge variant="outline" className="ml-auto">AgentSkills.io</Badge>
      </div>

      {clusterContext && (
        <ClusterContextBanner context={clusterContext} />
      )}

      {/* Input Section */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          {/* Skill selector dropdown */}
          <div>
            <label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
              <FolderOpen className="h-3 w-3" />Skill
            </label>
            <Select value={skillPath} onValueChange={handleSkillSelect}>
              <SelectTrigger className="h-9" data-testid="skill-selector">
                <SelectValue placeholder={loadingSkills ? 'Discovering skills...' : 'Select a skill'} />
              </SelectTrigger>
              <SelectContent>
                {availableSkills.map(s => (
                  <SelectItem key={s.path} value={s.path}>
                    <div className="flex items-center gap-2">
                      <span>{s.name}</span>
                      <span className="text-muted-foreground text-xs">— {s.source}</span>
                    </div>
                  </SelectItem>
                ))}
                <SelectItem value="__manual__">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <FolderOpen className="h-3 w-3" />
                    <span>Enter path manually...</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            {/* Manual path input */}
            {showManualPath && (
              <div className="flex gap-2 mt-2">
                <Input
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  placeholder="Path to skill directory (e.g., .claude/skills/my-skill)"
                  className="h-8 text-sm"
                  onKeyDown={(e) => e.key === 'Enter' && handleManualPathSubmit()}
                  data-testid="manual-path-input"
                  autoFocus
                />
                <Button size="sm" variant="outline" onClick={handleManualPathSubmit} disabled={!manualPath.trim()}>
                  Validate
                </Button>
              </div>
            )}
            {skillPath && !showManualPath && <PathBreadcrumb path={skillPath} />}
            {/* Upload file */}
            <div className="flex items-center gap-2 mt-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown"
                className="hidden"
                onChange={handleFileUpload}
              />
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-muted-foreground"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="h-3 w-3 mr-1" />Upload SKILL.md
              </Button>
            </div>
          </div>

          {/* Config row */}
          <div className="flex gap-3 items-center">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block">Agent Under Test</label>
              <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                <SelectTrigger className="h-9" data-testid="agent-selector">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  {agents.map(a => (
                    <SelectItem key={a.key} value={a.key}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1">
              <label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                <Scale className="h-3 w-3" />Judge Model
              </label>
              <Select value={selectedModel} onValueChange={setSelectedModel}>
                <SelectTrigger className="h-9" data-testid="judge-model-selector">
                  <SelectValue placeholder="Select judge model" />
                </SelectTrigger>
                <SelectContent>
                  {models.filter(m => !m.model_id.startsWith('mock://')).map(m => (
                    <SelectItem key={m.key} value={m.key}>{m.display_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 flex items-end">
              <Button
                className="w-full"
                data-testid="run-evaluation-btn"
                onClick={() => handleRunEval(false)}
                disabled={!validation?.valid || evalPhase === 'running'}
              >
                {evalPhase === 'running' ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-2" />Running...</>
                ) : (
                  <><Play className="h-4 w-4 mr-2" />Run Evaluation</>
                )}
              </Button>
            </div>
          </div>

          {/* Validation result */}
          {validation && (
            <div data-testid="validation-result" className={`flex items-start gap-3 p-3 rounded-md ${validation.valid ? 'bg-green-50 dark:bg-green-950/20' : 'bg-red-50 dark:bg-red-950/20'}`}>
              {validation.valid ? (
                <CheckCircle className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
              ) : (
                <XCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0 space-y-1">
                {validation.skill && (
                  <>
                    <div className="font-medium text-sm">{validation.skill.metadata.name}</div>
                    {/* Show full description — it's the *trigger* the loader matches against;
                        truncating it hides the most-important authored field. */}
                    <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                      {validation.skill.metadata.description}
                    </div>
                  </>
                )}
                {/* Hard validation errors — render inline (with the icon row) instead of
                    leaving an empty panel and showing the message in a separate strip. */}
                {!validation.valid && validation.errors.length > 0 && (
                  <ul className="space-y-1">
                    {validation.errors.map((e, i) => (
                      <li key={i} className="text-xs text-red-700 dark:text-red-400 break-words">{e}</li>
                    ))}
                  </ul>
                )}
                {validation.valid && (
                  <div className="text-xs text-muted-foreground">
                    {validation.evalsFile && <span>{validation.evalsFile.evals.length} eval cases</span>}
                    {!validation.evalsFile && (
                      <span className="text-amber-600">No evals — will auto-generate on run</span>
                    )}
                  </div>
                )}
                {validation.warnings.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {validation.warnings.map((w, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-500">
                        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span className="break-words">{w}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          {/* Separate strip only fires when validation never produced a result
              (e.g. fetch failure on the manual-path button) — not for normal
              parse errors, which now render inside the panel above. */}
          {validationError && !validation && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/20 text-sm text-red-600">{validationError}</div>
          )}

          {/* Progress bar */}
          {evalPhase === 'running' && (
            <div className="space-y-2">
              <Progress value={progressPercent} className="h-2" />
              <p className="text-xs text-muted-foreground">{progressText}</p>
              {evalOutcomes.length > 0 && (
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-green-600">
                    {evalOutcomes.filter(o => o.evalStatus === 'passed').length} passed
                  </span>
                  <span className="text-red-600">
                    {evalOutcomes.filter(o => o.evalStatus === 'failed').length} failed
                  </span>
                  {/* 'errored' is intentionally separate from 'failed': it means
                      the agent crashed / endpoint unreachable, not that the skill missed. */}
                  <span className="text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {evalOutcomes.filter(o => o.evalStatus === 'errored').length} errored
                  </span>
                </div>
              )}
            </div>
          )}
          {evalPhase === 'error' && (
            <div className="p-3 rounded-md bg-red-50 dark:bg-red-950/20 text-sm text-red-600">{progressText}</div>
          )}
        </CardContent>
      </Card>

      {/* Results Tabs */}
      {(validation?.valid || benchmark) && (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="skill">SKILL.md</TabsTrigger>
            <TabsTrigger value="results" disabled={!benchmark}>Results</TabsTrigger>
            <TabsTrigger value="improvement" disabled={!improvement}>Improvement</TabsTrigger>
            <TabsTrigger value="history" disabled={iterations.length === 0}>History ({iterations.length})</TabsTrigger>
          </TabsList>

          {/* SKILL.md Tab */}
          <TabsContent value="skill">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm font-medium">Skill Instructions</CardTitle>
              </CardHeader>
              <CardContent>
                <pre className="text-xs bg-muted p-4 rounded-md overflow-auto max-h-96 whitespace-pre-wrap font-mono">
                  {validation?.skill?.instructions || 'Validate a skill to view its instructions.'}
                </pre>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Results Tab */}
          <TabsContent value="results">
            {benchmark && (
              <Card>
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium">
                      Iteration {benchmark.iteration} — {benchmark.created_at.split('T')[0]}
                    </CardTitle>
                    <Badge variant={benchmark.run_summary.delta.pass_rate > 0 ? 'default' : 'destructive'}>
                      Delta: {fmtDelta(benchmark.run_summary.delta.pass_rate)}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Metric</TableHead>
                        <TableHead>With Skill</TableHead>
                        <TableHead>Without Skill</TableHead>
                        <TableHead>Delta</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell className="font-medium">Pass Rate</TableCell>
                        <TableCell>{fmtPct(benchmark.run_summary.with_skill.pass_rate.mean)}</TableCell>
                        <TableCell>{fmtPct(benchmark.run_summary.without_skill.pass_rate.mean)}</TableCell>
                        <TableCell className={benchmark.run_summary.delta.pass_rate >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {fmtDelta(benchmark.run_summary.delta.pass_rate)}
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Avg Time</TableCell>
                        <TableCell>{benchmark.run_summary.with_skill.time_seconds.mean.toFixed(1)}s</TableCell>
                        <TableCell>{benchmark.run_summary.without_skill.time_seconds.mean.toFixed(1)}s</TableCell>
                        <TableCell className={benchmark.run_summary.delta.time_seconds <= 0 ? 'text-green-600' : 'text-red-600'}>
                          {benchmark.run_summary.delta.time_seconds >= 0 ? '+' : ''}{benchmark.run_summary.delta.time_seconds.toFixed(1)}s
                        </TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell className="font-medium">Avg Tokens</TableCell>
                        <TableCell>{Math.round(benchmark.run_summary.with_skill.tokens.mean)}</TableCell>
                        <TableCell>{Math.round(benchmark.run_summary.without_skill.tokens.mean)}</TableCell>
                        <TableCell>{Math.round(benchmark.run_summary.delta.tokens)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Improvement Tab */}
          <TabsContent value="improvement">
            {improvement && (
              <Card>
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-medium flex items-center gap-2">
                      {improvement.applied ? (
                        <><CheckCircle className="h-4 w-4 text-green-600" />Improvement Applied</>
                      ) : (
                        <><ArrowUpCircle className="h-4 w-4 text-amber-600" />Improvement Proposed</>
                      )}
                    </CardTitle>
                    {!improvement.applied && (
                      <Button size="sm" onClick={() => handleRunEval(true)}>
                        <Wand2 className="h-3 w-3 mr-1" />Apply & Re-run
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Changes</p>
                    <p className="text-sm">{improvement.changes}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Reasoning</p>
                    <p className="text-sm">{improvement.reasoning}</p>
                  </div>
                  {improvement.improvedInstructions && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-1">Proposed Instructions</p>
                      <pre className="text-xs bg-muted p-4 rounded-md overflow-auto max-h-96 whitespace-pre-wrap font-mono">
                        {improvement.improvedInstructions}
                      </pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* History Tab */}
          <TabsContent value="history">
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm font-medium">Iteration History</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Iteration</TableHead>
                      <TableHead>With Skill</TableHead>
                      <TableHead>Without Skill</TableHead>
                      <TableHead>Delta</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {iterations.map((iter) => (
                      <TableRow
                        key={iter.iteration}
                        className="cursor-pointer hover:bg-muted/50"
                        onClick={() => { setBenchmark(iter); setActiveTab('results'); }}
                      >
                        <TableCell>#{iter.iteration}</TableCell>
                        <TableCell>{fmtPct(iter.run_summary.with_skill.pass_rate.mean)}</TableCell>
                        <TableCell>{fmtPct(iter.run_summary.without_skill.pass_rate.mean)}</TableCell>
                        <TableCell className={iter.run_summary.delta.pass_rate >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {fmtDelta(iter.run_summary.delta.pass_rate)}
                        </TableCell>
                        <TableCell>{iter.run_summary.with_skill.time_seconds.mean.toFixed(1)}s</TableCell>
                        <TableCell className="text-muted-foreground">{iter.created_at.split('T')[0]}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
};
