/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Play, Save, Star, CheckCircle2, XCircle, Loader2, ExternalLink, Clock, RefreshCw, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TestCase, TrajectoryStep } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
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

  // Ad-hoc run fields (when no testCase)
  const [adHocPrompt, setAdHocPrompt] = useState('');
  const [adHocName, setAdHocName] = useState('');

  // Run state
  const [isRunning, setIsRunning] = useState(false);
  const [currentSteps, setCurrentSteps] = useState<TrajectoryStep[]>([]);
  const [reportId, setReportId] = useState<string | null>(null);
  const [report, setReport] = useState<ServerEvaluationReport | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // LiteLLM dynamic model discovery
  const [litellmModels, setLitellmModels] = useState<string[]>([]);
  const [litellmDiscoveryState, setLitellmDiscoveryState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [litellmDiscoveryError, setLitellmDiscoveryError] = useState<string | null>(null);

  const selectedAgent = DEFAULT_CONFIG.agents.find(a => a.key === selectedAgentKey);

  // Group models by provider for the dropdown (includes dynamically discovered LiteLLM models)
  const modelsByProvider = Object.entries(DEFAULT_CONFIG.models).reduce((acc, [key, model]) => {
    const provider = model.provider || 'bedrock';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push({ key, ...model });
    return acc;
  }, {} as Record<string, Array<{ key: string; display_name: string; provider: string }>>);

  // Merge in discovered LiteLLM models (deduplicating against static config)
  const staticLitellmKeys = new Set((modelsByProvider['litellm'] || []).map(m => m.key));
  const discoveredLitellmModels = litellmModels
    .filter(id => !staticLitellmKeys.has(id))
    .map(id => ({ key: id, model_id: id, display_name: id, provider: 'litellm' }));
  if (discoveredLitellmModels.length > 0) {
    modelsByProvider['litellm'] = [...(modelsByProvider['litellm'] || []), ...discoveredLitellmModels];
  }

  const providerLabels: Record<string, string> = {
    demo: 'Demo',
    bedrock: 'AWS Bedrock',
    litellm: 'LiteLLM / OpenAI-compatible',
  };

  const fetchLitellmModels = useCallback(async () => {
    setLitellmDiscoveryState('loading');
    setLitellmDiscoveryError(null);
    try {
      const response = await fetch('/api/judge/litellm-models');
      const data = await response.json();
      if (!response.ok) {
        setLitellmDiscoveryState('error');
        setLitellmDiscoveryError(data.error || 'Failed to fetch models');
      } else {
        setLitellmModels(data.models || []);
        setLitellmDiscoveryState('done');
      }
    } catch (err: any) {
      setLitellmDiscoveryState('error');
      setLitellmDiscoveryError('Cannot reach server');
    }
  }, []);

  const selectedModelConfig = DEFAULT_CONFIG.models[selectedModelId] ||
    discoveredLitellmModels.find(m => m.key === selectedModelId) as any;
  const selectedModelProvider = selectedModelConfig?.provider || 'bedrock';

  // Lock body scroll when modal is open
  useEffect(() => {
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
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
        },
        (step) => setCurrentSteps(prev => [...prev, step])
      );

      // Report is saved server-side; use the returned summary
      setReportId(result.reportId);
      setReport(result.report);
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
                    {DEFAULT_CONFIG.agents.map(agent => (
                      <SelectItem
                        key={agent.key}
                        value={agent.key}
                      >
                        {agent.name}
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
                    className={`text-muted-foreground cursor-default ${selectedModelProvider === 'litellm' ? 'text-blue-500 dark:text-blue-400' : ''}`}
                    title={
                      selectedModelProvider === 'litellm'
                        ? 'LiteLLM / OpenAI-compatible — set LITELLM_ENDPOINT and LITELLM_API_KEY in .env. Click ↻ to discover available models.'
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
                      litellmDiscoveryState === 'done'
                        ? `${litellmModels.length} model${litellmModels.length !== 1 ? 's' : ''} discovered from LiteLLM endpoint`
                        : litellmDiscoveryState === 'error'
                        ? `LiteLLM endpoint unreachable: ${litellmDiscoveryError}`
                        : 'Discover models from LiteLLM / Ollama endpoint'
                    }
                    onClick={fetchLitellmModels}
                    disabled={litellmDiscoveryState === 'loading'}
                    className={`h-8 w-8 flex items-center justify-center rounded border bg-background disabled:opacity-50 ${
                      litellmDiscoveryState === 'done'
                        ? 'border-green-400 text-green-600 dark:text-green-400'
                        : litellmDiscoveryState === 'error'
                        ? 'border-amber-400 text-amber-600 dark:text-amber-400'
                        : 'border-input text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                  >
                    <RefreshCw size={12} className={litellmDiscoveryState === 'loading' ? 'animate-spin' : ''} />
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
