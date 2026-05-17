/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Play, Save, Star, CheckCircle2, XCircle, Loader2, ExternalLink, Clock, RefreshCw, Info, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TestCase, TrajectoryStep, Evaluator } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { ENV_CONFIG } from '@/lib/config';
import { parseLabels } from '@/lib/labels';
import { runServerEvaluation, ServerEvaluationReport } from '@/services/client/evaluationApi';
import { asyncTestCaseStorage } from '@/services/storage';
import { TrajectoryView } from './TrajectoryView';

interface QuickRunModalProps {
  testCase: TestCase | null; // null = ad-hoc run mode
  onClose: () => void;
  onSaveAsTestCase: (testCase: TestCase) => void;
}

export const QuickRunModal: React.FC<QuickRunModalProps> = ({
  testCase,
  onClose,
  onSaveAsTestCase,
}) => {
  const navigate = useNavigate();

  // Agent/Model selection - all agents are available since evaluation runs server-side
  const [selectedAgentKey, setSelectedAgentKey] = useState(
    () => DEFAULT_CONFIG.agents[0]?.key
  );
  const [selectedModelId, setSelectedModelId] = useState('claude-sonnet-4.5');
  const [selectedEvaluatorId, setSelectedEvaluatorId] = useState<string | undefined>();
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);

  // Ad-hoc run fields (when no testCase)
  const [adHocPrompt, setAdHocPrompt] = useState('');
  const [adHocName, setAdHocName] = useState('');

  // Run state
  const [isRunning, setIsRunning] = useState(false);
  const [currentSteps, setCurrentSteps] = useState<TrajectoryStep[]>([]);
  const [reportId, setReportId] = useState<string | null>(null);
  const [report, setReport] = useState<ServerEvaluationReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** When set, the inline SSE dropped and the modal is polling for completion. */
  const [reconnectState, setReconnectState] = useState<
    | null
    | { reportId: string; reason: string; lastStatus?: string }
  >(null);
  const [showBuiltInAgents, setShowBuiltInAgents] = useState(false);

  // OpenAI-compatible dynamic model discovery
  const [openaiCompatModels, setOpenaiCompatModels] = useState<string[]>([]);
  const [openaiCompatDiscoveryState, setOpenaiCompatDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [openaiCompatDiscoveryError, setOpenaiCompatDiscoveryError] = useState<string | null>(null);

  // Bedrock dynamic model discovery
  const [bedrockModels, setBedrockModels] = useState<Array<{ id: string; name: string }>>([]);
  const [bedrockDiscoveryState, setBedrockDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [bedrockDiscoveryError, setBedrockDiscoveryError] = useState<string | null>(null);

  const selectedAgent = DEFAULT_CONFIG.agents.find(a => a.key === selectedAgentKey);

  // Group models by provider for the dropdown (includes dynamically discovered OpenAI-compatible models)
  const modelsByProvider = Object.entries(DEFAULT_CONFIG.models).reduce((acc, [key, model]) => {
    const provider = model.provider || 'bedrock';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push({ key, ...model });
    return acc;
  }, {} as Record<string, Array<{ key: string; display_name: string; provider: string }>>);

  // Merge in discovered OpenAI-compatible models (deduplicating against static config)
  const staticOpenaiCompatKeys = new Set((modelsByProvider['openai-compatible'] || []).map(m => m.key));
  const discoveredOpenaiCompatModels = openaiCompatModels
    .filter(id => !staticOpenaiCompatKeys.has(id))
    .map(id => ({ key: id, model_id: id, display_name: id, provider: 'openai-compatible' }));
  if (discoveredOpenaiCompatModels.length > 0) {
    modelsByProvider['openai-compatible'] = [...(modelsByProvider['openai-compatible'] || []), ...discoveredOpenaiCompatModels];
  }

  // Merge in discovered Bedrock models (deduplicating against static config by model_id)
  const staticBedrockModelIds = new Set(
    (modelsByProvider['bedrock'] || []).map((m: any) => m.model_id || DEFAULT_CONFIG.models[m.key]?.model_id)
  );
  const discoveredBedrockModels = bedrockModels
    .filter(m => !staticBedrockModelIds.has(m.id))
    .map(m => ({ key: m.id, model_id: m.id, display_name: m.name, provider: 'bedrock' }));
  if (discoveredBedrockModels.length > 0) {
    modelsByProvider['bedrock'] = [...(modelsByProvider['bedrock'] || []), ...discoveredBedrockModels];
  }

  const providerLabels: Record<string, string> = {
    demo: 'Demo',
    bedrock: 'AWS Bedrock',
    'openai-compatible': 'OpenAI-compatible',
    'claude-code': 'Claude Code',
    litellm: 'LiteLLM',
    agentic: 'Agentic Judge',
  };

  const fetchOpenaiCompatModels = useCallback(async () => {
    setOpenaiCompatDiscoveryState('loading');
    setOpenaiCompatDiscoveryError(null);
    try {
      const response = await fetch('/api/judge/openai-compatible-models');
      const data = await response.json();
      if (!response.ok) {
        setOpenaiCompatDiscoveryState('error');
        setOpenaiCompatDiscoveryError(data.error || 'Failed to fetch models');
      } else {
        setOpenaiCompatModels(data.models || []);
        setOpenaiCompatDiscoveryState('done');
      }
    } catch (err: any) {
      setOpenaiCompatDiscoveryState('error');
      setOpenaiCompatDiscoveryError('Cannot reach server');
    }
  }, []);

  const fetchBedrockModels = useCallback(async () => {
    setBedrockDiscoveryState('loading');
    setBedrockDiscoveryError(null);
    try {
      const response = await fetch('/api/judge/bedrock-models');
      const data = await response.json();
      if (!response.ok) {
        setBedrockDiscoveryState('error');
        setBedrockDiscoveryError(data.error || 'Failed to fetch models');
      } else {
        setBedrockModels(data.models || []);
        setBedrockDiscoveryState('done');
      }
    } catch (err: any) {
      setBedrockDiscoveryState('error');
      setBedrockDiscoveryError('Cannot reach server');
    }
  }, []);

  const selectedModelConfig = DEFAULT_CONFIG.models[selectedModelId] ||
    discoveredOpenaiCompatModels.find(m => m.key === selectedModelId) ||
    discoveredBedrockModels.find(m => m.key === selectedModelId) as any;
  const selectedModelProvider = selectedModelConfig?.provider || 'bedrock';

  // Lock body scroll when modal is open
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  // Load evaluators
  useEffect(() => {
    const loadEvaluators = async () => {
      try {
        const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`);
        if (response.ok) {
          const data = await response.json();
          setEvaluators(data.evaluators || []);
        }
      } catch (error) {
        console.error('Failed to load evaluators:', error);
      }
    };
    loadEvaluators();
  }, []);

  const effectivePrompt = testCase ? testCase.initialPrompt : adHocPrompt;
  const effectiveName = testCase ? testCase.name : (adHocName || 'Ad-hoc Run');

  const handleRun = async () => {
    if (!effectivePrompt.trim() || !selectedAgent) return;

    setIsRunning(true);
    setCurrentSteps([]);
    setReport(null);
    setReportId(null);
    setErrorMessage(null);
    setReconnectState(null);

    try {
      // Build the request — use testCaseId for stored test cases, inline object for ad-hoc
      const runTestCase: TestCase | undefined = testCase ? undefined : {
        id: `adhoc-${Date.now()}`,
        name: effectiveName,
        description: 'Ad-hoc evaluation run',
        labels: ['category:Ad-hoc', 'difficulty:Medium'],
        category: 'Ad-hoc',
        difficulty: 'Medium',
        currentVersion: 1,
        versions: [{
          version: 1,
          createdAt: new Date().toISOString(),
          initialPrompt: adHocPrompt,
          context: [],
          expectedTrajectory: [],
        }],
        isPromoted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        initialPrompt: adHocPrompt,
        context: [],
        expectedTrajectory: [],
      };

      const result = await runServerEvaluation(
        {
          agentKey: selectedAgent.key,
          modelId: selectedModelId,
          testCaseId: testCase?.id,
          testCase: runTestCase,
          evaluatorId: selectedEvaluatorId,
        },
        {
          onStep: (step) => setCurrentSteps(prev => [...prev, step]),
          onReconnect: (id, reason) => setReconnectState({ reportId: id, reason }),
          onPoll: (r) => setReconnectState(prev => prev ? { ...prev, lastStatus: r.status } : prev),
        }
      );

      // Report is saved server-side; use the returned summary
      setReportId(result.reportId);
      setReport(result.report);
      setReconnectState(null);
    } catch (error) {
      console.error('Evaluation error:', error);
      setErrorMessage(error instanceof Error ? error.message : 'Evaluation failed');
    } finally {
      setIsRunning(false);
    }
  };

  const handleSaveAsTestCase = async () => {
    if (!adHocPrompt.trim() || !adHocName.trim()) return;

    const newTestCase = await asyncTestCaseStorage.create({
      name: adHocName,
      description: 'Created from Quick Run',
      category: 'User Created',
      difficulty: 'Medium',
      initialPrompt: adHocPrompt,
      context: [],
      expectedTrajectory: [],
    });

    onSaveAsTestCase(newTestCase);
  };

  const handlePromoteForExperiments = async () => {
    if (!adHocPrompt.trim() || !adHocName.trim()) return;

    const newTestCase = await asyncTestCaseStorage.create({
      name: adHocName,
      description: 'Created from Quick Run',
      category: 'User Created',
      difficulty: 'Medium',
      initialPrompt: adHocPrompt,
      context: [],
      expectedTrajectory: [],
      isPromoted: true,
    });

    onSaveAsTestCase(newTestCase);
  };

  const canRun = effectivePrompt.trim() && selectedAgent && !isRunning;
  const canSave = !testCase && adHocPrompt.trim() && adHocName.trim();
  const hasResults = report !== null;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 overflow-hidden"
      onWheel={(e) => e.stopPropagation()}
    >
      <Card className="w-full max-w-4xl h-[90vh] flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div>
            <CardTitle>
              {testCase ? `Run: ${testCase.name}` : 'Quick Run'}
            </CardTitle>
            {testCase && (
              <p className="text-xs text-muted-foreground mt-1">
                Version {testCase.currentVersion} · {parseLabels(testCase.labels || []).category || 'Uncategorized'}
              </p>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={isRunning}>
            <X size={18} />
          </Button>
        </CardHeader>

        <CardContent className="flex-1 overflow-hidden p-0 min-h-0">
          <div className="flex flex-col h-full min-h-0">
            {/* Config Bar */}
            <div className="p-4 border-b flex items-end gap-4">
              {/* Ad-hoc prompt input (only when no testCase) */}
              {!testCase && (
                <div className="flex-1 space-y-2">
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Label htmlFor="name" className="text-xs">Name</Label>
                      <Input
                        id="name"
                        value={adHocName}
                        onChange={e => setAdHocName(e.target.value)}
                        placeholder="Name for this run..."
                        className="h-8"
                      />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="prompt" className="text-xs">Prompt</Label>
                    <Textarea
                      id="prompt"
                      value={adHocPrompt}
                      onChange={e => setAdHocPrompt(e.target.value)}
                      placeholder="Enter your query..."
                      rows={2}
                      className="resize-none"
                    />
                  </div>
                </div>
              )}

              {/* Agent Selection */}
              <div className="space-y-1">
                <Label className="text-xs">Agent</Label>
                <Select value={selectedAgentKey} onValueChange={setSelectedAgentKey}>
                  <SelectTrigger className="w-48 h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Custom agents first (if any exist) */}
                    {DEFAULT_CONFIG.agents.filter(a => a.builtIn === false).length > 0 && (
                      <SelectGroup>
                        <SelectLabel className="text-xs">Your Agents</SelectLabel>
                        {DEFAULT_CONFIG.agents.filter(a => a.builtIn === false).map(agent => (
                          <SelectItem key={agent.key} value={agent.key}>{agent.name}</SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {/* Built-in agents (collapsed by default) */}
                    <SelectGroup>
                      <button
                        type="button"
                        className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground w-full"
                        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setShowBuiltInAgents(!showBuiltInAgents); }}
                      >
                        <ChevronRight size={12} className={showBuiltInAgents ? 'rotate-90 transition-transform' : 'transition-transform'} />
                        Built-in ({DEFAULT_CONFIG.agents.filter(a => a.builtIn !== false).length})
                      </button>
                      {showBuiltInAgents && DEFAULT_CONFIG.agents.filter(a => a.builtIn !== false).map(agent => (
                        <SelectItem key={agent.key} value={agent.key}>{agent.name}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              {/* Evaluator Selection */}
              <div className="space-y-1">
                <Label className="text-xs">Evaluator</Label>
                <Select value={selectedEvaluatorId || '__default__'} onValueChange={val => setSelectedEvaluatorId(val === '__default__' ? undefined : val)}>
                  <SelectTrigger className="w-44 h-8">
                    <SelectValue placeholder="RCA Default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">RCA Default</SelectItem>
                    {evaluators.map(evaluator => (
                      <SelectItem key={evaluator.id} value={evaluator.id}>
                        {evaluator.name} {evaluator.isSystem ? '(System)' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Model Selection (grouped by provider) */}
              <div className="space-y-1">
                <div className="flex items-center gap-1">
                  <Label className="text-xs">Judge Model</Label>
                  <span
                    className={`text-muted-foreground cursor-default ${selectedModelProvider === 'openai-compatible' ? 'text-blue-500 dark:text-blue-400' : selectedModelProvider === 'agentic' ? 'text-purple-500 dark:text-purple-400' : ''}`}
                    title={
                      selectedModelProvider === 'openai-compatible'
                        ? 'OpenAI-compatible — set OPENAI_COMPATIBLE_ENDPOINT and OPENAI_COMPATIBLE_API_KEY in .env. Click ↻ to discover available models.'
                        : selectedModelProvider === 'agentic'
                        ? 'Agentic Judge — uses an agent with tool access to evaluate trajectories. Supports Claude Code or custom endpoints.'
                        : selectedModelProvider === 'claude-code'
                        ? 'Claude Code — spawns the claude CLI to evaluate trajectories.'
                        : 'Select the LLM used to judge agent trajectories'
                    }
                  >
                    <Info size={11} className="inline" />
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                    <SelectTrigger className="w-44 h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(modelsByProvider).map(([provider, models]) => (
                        <SelectGroup key={provider}>
                          <SelectLabel>{providerLabels[provider] || provider}</SelectLabel>
                          {models.map(model => (
                            <SelectItem key={model.key} value={model.key}>
                              {model.display_name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                  <button
                    type="button"
                    title={
                      bedrockDiscoveryState === 'done' || openaiCompatDiscoveryState === 'done'
                        ? [
                            bedrockDiscoveryState === 'done' ? `${bedrockModels.length} Bedrock model${bedrockModels.length !== 1 ? 's' : ''}` : null,
                            openaiCompatDiscoveryState === 'done' ? `${openaiCompatModels.length} OpenAI-compatible model${openaiCompatModels.length !== 1 ? 's' : ''}` : null,
                          ].filter(Boolean).join(', ') + ' discovered'
                        : bedrockDiscoveryState === 'error' && openaiCompatDiscoveryState === 'error'
                        ? `Bedrock: ${bedrockDiscoveryError}; OpenAI: ${openaiCompatDiscoveryError}`
                        : bedrockDiscoveryState === 'error'
                        ? `Bedrock discovery failed: ${bedrockDiscoveryError}`
                        : openaiCompatDiscoveryState === 'error'
                        ? `OpenAI-compatible discovery failed: ${openaiCompatDiscoveryError}`
                        : 'Discover models from Bedrock and OpenAI-compatible endpoints'
                    }
                    onClick={() => { fetchBedrockModels(); fetchOpenaiCompatModels(); }}
                    disabled={bedrockDiscoveryState === 'loading' || openaiCompatDiscoveryState === 'loading'}
                    className={`h-8 w-8 flex items-center justify-center rounded border bg-background disabled:opacity-50 ${
                      bedrockDiscoveryState === 'done' || openaiCompatDiscoveryState === 'done'
                        ? 'border-green-400 text-green-600 dark:text-green-400'
                        : bedrockDiscoveryState === 'error' || openaiCompatDiscoveryState === 'error'
                        ? 'border-amber-400 text-amber-600 dark:text-amber-400'
                        : 'border-input text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                  >
                    <RefreshCw size={12} className={bedrockDiscoveryState === 'loading' || openaiCompatDiscoveryState === 'loading' ? 'animate-spin' : ''} />
                  </button>
                </div>
              </div>

              {/* Run Button */}
              <Button
                onClick={handleRun}
                disabled={!canRun}
                className="bg-opensearch-blue hover:bg-blue-600 h-8"
              >
                {isRunning ? (
                  <>
                    <Loader2 size={14} className="mr-1 animate-spin" />
                    Running...
                  </>
                ) : (
                  <>
                    <Play size={14} className="mr-1" />
                    Run
                  </>
                )}
              </Button>
            </div>

            {/* Results Area */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              {errorMessage && (
                <div className="mb-4 p-3 text-sm text-red-600 bg-red-50 rounded border border-red-200">
                  {errorMessage}
                </div>
              )}
              {reconnectState && !report && (
                <div className="mb-4 p-3 text-sm rounded border border-amber-300 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-300 flex items-start gap-2">
                  <Loader2 size={14} className="mt-0.5 animate-spin shrink-0" />
                  <div>
                    <div className="font-medium">Stream disconnected — reconnecting via polling…</div>
                    <div className="text-xs opacity-80 mt-0.5">
                      The server is still running the evaluation. Waiting for it to finish.
                      {reconnectState.lastStatus ? ` (status: ${reconnectState.lastStatus})` : ''}
                    </div>
                  </div>
                </div>
              )}
              {currentSteps.length > 0 || report ? (
                <div className="space-y-4">
                  {/* Status Badge */}
                  {report && (
                    <div className="flex items-center gap-4">
                      {report.metricsStatus === 'pending' ? (
                        <Badge className="bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-500/20 dark:text-amber-400 dark:border-amber-500/30 text-sm px-3 py-1">
                          <Clock size={14} className="mr-1" />
                          PENDING
                        </Badge>
                      ) : report.passFailStatus === 'passed' ? (
                        <Badge className="bg-green-100 text-green-700 border-green-300 dark:bg-green-500/20 dark:text-green-400 dark:border-green-500/30 text-sm px-3 py-1">
                          <CheckCircle2 size={14} className="mr-1" />
                          PASSED
                        </Badge>
                      ) : (
                        <Badge className="bg-red-100 text-red-700 border-red-300 dark:bg-red-500/20 dark:text-red-400 dark:border-red-500/30 text-sm px-3 py-1">
                          <XCircle size={14} className="mr-1" />
                          FAILED
                        </Badge>
                      )}
                      <span className="text-sm text-muted-foreground">
                        Accuracy: {report.metrics.accuracy}%
                      </span>
                    </div>
                  )}

                  {/* Trajectory */}
                  <div>
                    <h4 className="text-sm font-semibold text-muted-foreground uppercase mb-2">Trajectory</h4>
                    <TrajectoryView
                      steps={currentSteps}
                      loading={isRunning}
                    />
                  </div>

                  {/* LLM Judge Reasoning */}
                  {report?.llmJudgeReasoning && (
                    <div>
                      <h4 className="text-sm font-semibold text-muted-foreground uppercase mb-2">LLM Judge Reasoning</h4>
                      <Card className="bg-muted/30">
                        <CardContent className="p-3 text-sm">
                          {report.llmJudgeReasoning}
                        </CardContent>
                      </Card>
                    </div>
                  )}
                </div>
              ) : isRunning ? (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                  <Loader2 size={48} className="mb-4 animate-spin text-opensearch-blue" />
                  <p className="text-lg font-medium">Starting evaluation...</p>
                  <p className="text-sm mt-1">Connecting to agent and waiting for first response</p>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                  <Play size={48} className="mb-4 opacity-20" />
                  <p>{testCase ? 'Click Run to start the evaluation' : 'Enter a prompt and click Run'}</p>
                </div>
              )}
            </div>

            {/* Footer Actions */}
            {hasResults ? (
              <div className="p-4 border-t flex justify-between items-center">
                {/* View Run Details - available for all runs with a saved report */}
                <Button
                  variant="outline"
                  onClick={() => {
                    if (reportId) {
                      onClose();
                      navigate(`/runs/${reportId}`);
                    }
                  }}
                  className="gap-1.5"
                >
                  <ExternalLink size={14} />
                  View Run Details
                </Button>

                {/* Ad-hoc run actions */}
                {!testCase && (
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={handleSaveAsTestCase}
                      disabled={!canSave}
                    >
                      <Save size={14} className="mr-1" />
                      Save as Test Case
                    </Button>
                    <Button
                      onClick={handlePromoteForExperiments}
                      disabled={!canSave}
                      className="bg-amber-500 hover:bg-amber-600"
                    >
                      <Star size={14} className="mr-1" />
                      Promote for Experiments
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
