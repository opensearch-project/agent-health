/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, Play, Save, Star, CheckCircle2, XCircle, Loader2, ExternalLink, Clock, Terminal } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { TestCase, TrajectoryStep, EvaluationReport } from '@/types';
import { DEFAULT_CONFIG } from '@/lib/constants';
import { parseLabels } from '@/lib/labels';
import { isBrowserCompatible, getFirstBrowserCompatibleAgent } from '@/lib/agentUtils';
import { runEvaluation } from '@/services/evaluation';
import { asyncTestCaseStorage, asyncRunStorage } from '@/services/storage';
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

  // Agent/Model selection - default to first browser-compatible agent
  const [selectedAgentKey, setSelectedAgentKey] = useState(
    () => getFirstBrowserCompatibleAgent(DEFAULT_CONFIG.agents)?.key || DEFAULT_CONFIG.agents[0]?.key
  );
  const [selectedModelId, setSelectedModelId] = useState('claude-sonnet-4.5');

  // Ad-hoc run fields (when no testCase)
  const [adHocPrompt, setAdHocPrompt] = useState('');
  const [adHocName, setAdHocName] = useState('');

  // Run state
  const [isRunning, setIsRunning] = useState(false);
  const [currentSteps, setCurrentSteps] = useState<TrajectoryStep[]>([]);
  const [report, setReport] = useState<EvaluationReport | null>(null);

  const selectedAgent = DEFAULT_CONFIG.agents.find(a => a.key === selectedAgentKey);

  // Group models by provider for the dropdown
  const modelsByProvider = Object.entries(DEFAULT_CONFIG.models).reduce((acc, [key, model]) => {
    const provider = model.provider || 'bedrock';
    if (!acc[provider]) acc[provider] = [];
    acc[provider].push({ key, ...model });
    return acc;
  }, {} as Record<string, Array<{ key: string; display_name: string; provider: string }>>);

  const providerLabels: Record<string, string> = {
    demo: 'Demo',
    bedrock: 'AWS Bedrock',
    ollama: 'Ollama',
    openai: 'OpenAI',
  };

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

    try {
      // Create a temporary test case for ad-hoc runs
      const runTestCase: TestCase = testCase || {
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

      const result = await runEvaluation(
        selectedAgent,
        selectedModelId,
        runTestCase,
        (step) => setCurrentSteps(prev => [...prev, step])
      );

      // Add testCaseVersion to the report
      const reportWithVersion = {
        ...result,
        testCaseVersion: testCase?.currentVersion ?? 1,
      };

      // Save the report and use the returned report with the correct storage ID
      const savedReport = await asyncRunStorage.saveReport(reportWithVersion);
      setReport(savedReport);
    } catch (error) {
      console.error('Evaluation error:', error);
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
          <Button variant="ghost" size="icon" onClick={onClose}>
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
                    {DEFAULT_CONFIG.agents.map(agent => {
                      const isAvailable = isBrowserCompatible(agent);
                      return (
                        <SelectItem
                          key={agent.key}
                          value={agent.key}
                          disabled={!isAvailable}
                        >
                          {agent.name}
                          {!isAvailable && <span className="text-xs text-muted-foreground ml-1">(CLI only)</span>}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>

              {/* Model Selection (grouped by provider) */}
              <div className="space-y-1">
                <Label className="text-xs">Judge Model</Label>
                <Select value={selectedModelId} onValueChange={setSelectedModelId}>
                  <SelectTrigger className="w-48 h-8">
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
              </div>

              {/* Run Button */}
              <Button
                onClick={handleRun}
                disabled={!canRun || (selectedAgent && !isBrowserCompatible(selectedAgent))}
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

            {/* CLI-only agent warning */}
            {selectedAgent && !isBrowserCompatible(selectedAgent) && (
              <div className="px-4 pb-2">
                <Alert className="bg-amber-900/20 border-amber-700/30">
                  <Terminal className="h-4 w-4 text-amber-400" />
                  <AlertDescription className="text-amber-400">
                    {selectedAgent.name} requires the CLI. Run: <code className="bg-amber-900/30 px-1 py-0.5 rounded text-xs">npx @opensearch-project/agent-health run -a {selectedAgent.key} -t &quot;{testCase?.name || 'test-case-name'}&quot;</code>
                  </AlertDescription>
                </Alert>
              </div>
            )}

            {/* Results Area */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              {currentSteps.length > 0 || report ? (
                <div className="space-y-4">
                  {/* Status Badge */}
                  {report && (
                    <div className="flex items-center gap-4">
                      {report.metricsStatus === 'pending' ? (
                        <Badge className="bg-amber-500/20 text-amber-400 text-sm px-3 py-1">
                          <Clock size={14} className="mr-1" />
                          PENDING
                        </Badge>
                      ) : report.passFailStatus === 'passed' ? (
                        <Badge className="bg-opensearch-blue/20 text-opensearch-blue text-sm px-3 py-1">
                          <CheckCircle2 size={14} className="mr-1" />
                          PASSED
                        </Badge>
                      ) : (
                        <Badge className="bg-red-500/20 text-red-400 text-sm px-3 py-1">
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
                    if (report) {
                      onClose();
                      navigate(`/runs/${report.id}`);
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
