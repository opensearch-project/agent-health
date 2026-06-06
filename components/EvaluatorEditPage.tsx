/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { Save, X, Plus, Trash2, ArrowLeft, Lock, Pencil, Copy } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ENV_CONFIG } from '@/lib/config';
import type { Evaluator, ScoringMetric } from '@/types';
import { EvaluatorVersionHistory } from '@/components/evaluators/EvaluatorVersionHistory';

export const EvaluatorEditPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { evaluatorId } = useParams();
  const isEditMode = !!evaluatorId;
  // The same component renders /evaluators/:id (view) and /evaluators/:id/edit
  // (edit). View mode is the default for existing evaluators — it prevents
  // accidental commits when the user just wants to read the prompt or look at
  // history. New evaluator creation (`/evaluators/new`) is always editable.
  const isViewRoute = isEditMode && !/\/edit\/?$/.test(location.pathname);
  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [isSystem, setIsSystem] = useState(false);
  // Track the currently-loaded version so we can show "v{N}" in the header
  // and on the Latest tab — this is what tells the user the save "took".
  const [currentVersion, setCurrentVersion] = useState<number>(1);
  // View mode is tab-based: "latest" shows the editor surface as read-only,
  // "history" shows EvaluatorVersionHistory. Initial tab comes from the URL
  // hash so the History icon-button on the list deep-links straight in.
  const initialTab: 'latest' | 'history' = location.hash === '#history' ? 'history' : 'latest';
  const [activeTab, setActiveTab] = useState<'latest' | 'history'>(initialTab);

  // System evaluators are immutable; explicit view-mode also locks the form.
  // We keep `isSystem` as its own flag so we can still show "System (read-only)"
  // copy distinct from the editable-but-currently-viewing case.
  const readOnly = isSystem || isViewRoute;

  // Form state
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [metrics, setMetrics] = useState<ScoringMetric[]>([
    { name: 'accuracy', description: 'Overall accuracy score', weight: 1.0, scale: 100 },
  ]);
  const [passThreshold, setPassThreshold] = useState(70);
  const [provider, setProvider] = useState<string>('');
  const [modelId, setModelId] = useState('');
  const [temperature, setTemperature] = useState(0.1);
  const [maxTokens, setMaxTokens] = useState(4096);

  useEffect(() => {
    if (isEditMode && evaluatorId) {
      loadEvaluator(evaluatorId);
    }
  }, [evaluatorId, isEditMode]);

  // Keep the active tab in sync with the URL hash so back/forward navigation
  // and copy-pasted #history links land on the right pane.
  useEffect(() => {
    const next = location.hash === '#history' ? 'history' : 'latest';
    setActiveTab(next);
  }, [location.hash]);

  // When the user switches tabs, mirror that into the URL hash so it's
  // shareable / back-button friendly. `replace: true` keeps the history
  // stack tidy — tab switches aren't really separate "pages".
  const handleTabChange = (value: string) => {
    if (value === 'history') {
      navigate({ hash: '#history' }, { replace: true });
    } else {
      navigate({ hash: '' }, { replace: true });
    }
  };

  const loadEvaluator = async (id: string) => {
    try {
      setLoading(true);
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators/${id}`);
      if (!response.ok) {
        throw new Error('Failed to load evaluator');
      }
      const evaluator: Evaluator = await response.json();

      setName(evaluator.name);
      setDescription(evaluator.description);
      setSystemPrompt(evaluator.systemPrompt);
      setMetrics(evaluator.scoringConfig.metrics);
      setPassThreshold(evaluator.scoringConfig.passThreshold);
      setProvider(evaluator.inferenceConfig?.provider || '');
      setModelId(evaluator.inferenceConfig?.modelId || '');
      setTemperature(evaluator.inferenceConfig?.temperature ?? 0.1);
      setMaxTokens(evaluator.inferenceConfig?.maxTokens ?? 4096);
      setIsSystem(evaluator.isSystem);
      setCurrentVersion(evaluator.currentVersion ?? 1);
    } catch (error) {
      console.error('Error loading evaluator:', error);
      alert('Failed to load evaluator');
      navigate('/evaluators');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      alert('Name is required');
      return;
    }
    if (!systemPrompt.trim()) {
      alert('System prompt is required');
      return;
    }
    if (metrics.length === 0) {
      alert('At least one metric is required');
      return;
    }

    try {
      setSaving(true);

      const payload = {
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        scoringConfig: {
          metrics,
          passThreshold,
          scale: 100,
        },
        inferenceConfig: {
          ...(provider && { provider }),
          ...(modelId && { modelId }),
          temperature,
          maxTokens,
        },
      };

      const url = isEditMode
        ? `${ENV_CONFIG.backendUrl}/api/storage/evaluators/${evaluatorId}`
        : `${ENV_CONFIG.backendUrl}/api/storage/evaluators`;

      const method = isEditMode ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to save evaluator');
      }

      // After save, send the user to view mode so they can:
      //   1. confirm the change persisted (form fields are now read-only)
      //   2. see the new version number land in the header pill
      //   3. inspect history if they want to diff what changed
      // For new evaluators, the POST response contains the freshly-minted id.
      if (!isEditMode) {
        const created = await response.json().catch(() => null);
        if (created?.id) {
          navigate(`/evaluators/${created.id}`);
        } else {
          navigate('/evaluators');
        }
      } else {
        // Updated existing evaluator: refresh in-memory state from the PUT
        // response so the version pill and the form fields immediately
        // reflect the persisted snapshot — navigating to /evaluators/:id
        // alone wouldn't refire loadEvaluator (the route params are
        // unchanged from the user's perspective), so without this the
        // header would still read v{N-1} after a save.
        const updated = await response.json().catch(() => null);
        if (updated) {
          setCurrentVersion(updated.currentVersion ?? currentVersion + 1);
          if (updated.systemPrompt != null) setSystemPrompt(updated.systemPrompt);
          if (updated.scoringConfig?.metrics) setMetrics(updated.scoringConfig.metrics);
          if (typeof updated.scoringConfig?.passThreshold === 'number') {
            setPassThreshold(updated.scoringConfig.passThreshold);
          }
        }
        // Strip any #history hash so we land on the Latest tab — that's
        // where the user can immediately verify their edit took effect.
        navigate(`/evaluators/${evaluatorId}`, { replace: true });
      }
    } catch (error: any) {
      console.error('Error saving evaluator:', error);
      alert(error.message || 'Failed to save evaluator');
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!evaluatorId) return;
    try {
      setDuplicating(true);
      // POST /api/storage/evaluators creates v1 of a brand-new evaluator with
      // a server-assigned id. We mirror EvaluatorsPage's duplicate behavior so
      // the user lands on the list afterwards and can locate the copy.
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${name} (Copy)`,
          description,
          systemPrompt,
          scoringConfig: { metrics, passThreshold, scale: 100 },
          inferenceConfig: {
            ...(provider && { provider }),
            ...(modelId && { modelId }),
            temperature,
            maxTokens,
          },
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to duplicate evaluator');
      }
      const created = await response.json();
      // Take the user straight to the new evaluator's view page so they can
      // start editing immediately if they want — same flow as a fresh save.
      navigate(`/evaluators/${created.id}`);
    } catch (e: any) {
      alert(e.message || 'Failed to duplicate evaluator');
    } finally {
      setDuplicating(false);
    }
  };

  const handleAddMetric = () => {
    setMetrics([
      ...metrics,
      { name: '', description: '', weight: 1.0, scale: 100 },
    ]);
  };

  const handleRemoveMetric = (index: number) => {
    setMetrics(metrics.filter((_, i) => i !== index));
  };

  const handleMetricChange = (index: number, field: keyof ScoringMetric, value: any) => {
    const updated = [...metrics];
    updated[index] = { ...updated[index], [field]: value };
    setMetrics(updated);
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-center py-12 text-muted-foreground">Loading evaluator...</div>
      </div>
    );
  }

  const pageTitle = !isEditMode
    ? 'New Evaluator'
    : isSystem
      ? 'View Evaluator'
      : isViewRoute
        ? 'View Evaluator'
        : 'Edit Evaluator';
  const promptCharCount = systemPrompt.length;
  const promptLineCount = systemPrompt ? systemPrompt.split('\n').length : 0;

  return (
    <div className="flex flex-col min-h-full">
      {/* Sticky header — keeps title + actions reachable while scrolling. */}
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto w-full max-w-[1600px] px-6 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/evaluators')}
            aria-label="Back to evaluators"
            className="shrink-0"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-semibold leading-tight truncate">{pageTitle}</h1>
              {/* Version pill — only meaningful for an existing evaluator;
                  this is the visual cue that the last save "took" because
                  it bumps from v{N} to v{N+1} on each successful update. */}
              {isEditMode && (
                <Badge variant="outline" className="font-mono text-[11px]">
                  v{currentVersion}
                </Badge>
              )}
              {isSystem && (
                <Badge variant="secondary" className="gap-1">
                  <Lock className="h-3 w-3" />
                  System (read-only)
                </Badge>
              )}
            </div>
            {isEditMode && name && (
              <p className="text-xs text-muted-foreground truncate">{name}</p>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={() => {
                // Cancelling a fresh edit returns to the view page for the
                // same evaluator (more natural than dumping the user back
                // to the list mid-task). View-mode "Close" and new-mode
                // Cancel both go to the list.
                if (isEditMode && !isViewRoute && evaluatorId) {
                  navigate(`/evaluators/${evaluatorId}`);
                } else {
                  navigate('/evaluators');
                }
              }}
            >
              <X className="h-4 w-4 mr-2" />
              {isViewRoute ? 'Close' : 'Cancel'}
            </Button>
            {/* View mode: Duplicate + Edit buttons — explicit "enter edit" gate
                so users can't accidentally clobber a saved prompt. */}
            {isEditMode && isViewRoute && !isSystem && (
              <>
                <Button variant="outline" onClick={handleDuplicate} disabled={duplicating}>
                  <Copy className="h-4 w-4 mr-2" />
                  {duplicating ? 'Duplicating…' : 'Duplicate'}
                </Button>
                <Button onClick={() => navigate(`/evaluators/${evaluatorId}/edit`)}>
                  <Pencil className="h-4 w-4 mr-2" />
                  Edit
                </Button>
              </>
            )}
            {/* System evaluators: only Duplicate (no Edit, no Save) */}
            {isSystem && (
              <Button variant="outline" onClick={handleDuplicate} disabled={duplicating}>
                <Copy className="h-4 w-4 mr-2" />
                {duplicating ? 'Duplicating…' : 'Duplicate'}
              </Button>
            )}
            {/* Edit / new mode: Save */}
            {!isSystem && !isViewRoute && (
              <Button onClick={handleSave} disabled={saving}>
                <Save className="h-4 w-4 mr-2" />
                {saving ? 'Saving...' : 'Save'}
              </Button>
            )}
          </div>
        </div>

        {isSystem && (
          <div className="border-t bg-muted/30">
            <div className="mx-auto w-full max-w-[1600px] px-6 py-2 text-xs text-muted-foreground">
              System evaluators are immutable. Duplicate to create an editable copy.
            </div>
          </div>
        )}
        {!isSystem && isViewRoute && (
          <div className="border-t bg-muted/30">
            <div className="mx-auto w-full max-w-[1600px] px-6 py-2 text-xs text-muted-foreground">
              Read-only view. Click <span className="font-medium">Edit</span> to modify this evaluator — a new immutable version is created on save.
            </div>
          </div>
        )}
      </header>

      {/* Body — full width with a sane cap, no more empty left column. */}
      <div className="mx-auto w-full max-w-[1600px] px-6 py-6">
        {/* In view mode (existing custom or system evaluator), the body is a
            two-tab interface: "Latest" surfaces the read-only editor view,
            "History" shows EvaluatorVersionHistory. The active tab is mirrored
            into the URL hash so:
              - the History icon on the list opens directly on "History"
              - back/forward + copy-pasted links land on the right pane.
            New mode and Edit mode both render the form directly (no tabs)
            because there's only one thing the user can be doing on those
            pages — saving content into v1 or vN+1 respectively. */}
        {/* The form lives inside Tabs in every mode so we never duplicate the
            ~250 lines of aside+main markup. Only view mode shows the actual
            tab switcher (TabsList); new and edit modes pin the user on the
            Latest pane because they have only one job there. The History pane
            is gated on isEditMode — a brand-new evaluator has no versions
            yet, so wiring it up would be misleading. */}
        <Tabs
          value={isViewRoute ? activeTab : 'latest'}
          onValueChange={handleTabChange}
          className="space-y-6"
        >
          {isEditMode && isViewRoute && (
            <TabsList>
              <TabsTrigger value="latest">
                Latest
                <Badge variant="secondary" className="ml-2 font-mono text-[10px]">v{currentVersion}</Badge>
              </TabsTrigger>
              <TabsTrigger value="history" disabled={isSystem || currentVersion < 2}>
                History
                <Badge variant="secondary" className="ml-2 font-mono text-[10px]">{currentVersion}</Badge>
              </TabsTrigger>
            </TabsList>
          )}

          <TabsContent value="latest" className="mt-0">
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-6 items-start">
          {/* ───────── Sidebar: small, dense metadata ───────── */}
          <aside className="space-y-6 lg:sticky lg:top-[88px]">
            {/* Basic Info */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Basic Information</CardTitle>
                <CardDescription>Identifies this evaluator in the UI and reports.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g., Factuality Checker"
                    disabled={readOnly}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe what this evaluator assesses..."
                    rows={4}
                    disabled={readOnly}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Inference Config */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Inference Configuration</CardTitle>
                <CardDescription>
                  Optional — overrides the default judge model for this evaluator.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="provider">Provider</Label>
                  <Select
                    value={provider || 'default'}
                    onValueChange={(val) => setProvider(val === 'default' ? '' : val)}
                    disabled={readOnly}
                  >
                    <SelectTrigger id="provider">
                      <SelectValue placeholder="Default" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      <SelectItem value="bedrock">Bedrock</SelectItem>
                      <SelectItem value="openai-compatible">OpenAI Compatible</SelectItem>
                      <SelectItem value="demo">Demo</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="modelId">Model ID</Label>
                  <Input
                    id="modelId"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder="Optional override"
                    disabled={readOnly}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="temperature">Temperature</Label>
                    <Input
                      id="temperature"
                      type="number"
                      value={temperature}
                      onChange={(e) => setTemperature(parseFloat(e.target.value) || 0.1)}
                      min="0"
                      max="1"
                      step="0.1"
                      disabled={readOnly}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="maxTokens">Max Tokens</Label>
                    <Input
                      id="maxTokens"
                      type="number"
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(parseInt(e.target.value) || 4096)}
                      min="256"
                      max="8192"
                      step="256"
                      disabled={readOnly}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>
          </aside>

          {/* ───────── Main: the actual editor surface ───────── */}
          <main className="space-y-6 min-w-0">
            {/* System Prompt — the hero. Gets the most space. */}
            <Card className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <CardTitle className="text-base">System Prompt *</CardTitle>
                    <CardDescription>
                      Instructions for the LLM judge. Define evaluation criteria and the expected
                      output format here.
                    </CardDescription>
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums shrink-0 pt-0.5">
                    {promptLineCount.toLocaleString()} lines · {promptCharCount.toLocaleString()} chars
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="You are an expert evaluator..."
                  // Tall by default so users can actually read the prompt without
                  // a scrollbar inside a tiny window. Resize-y lets them grow it.
                  className="font-mono text-sm leading-relaxed resize-y min-h-[60vh] lg:min-h-[calc(100vh-260px)]"
                  spellCheck={false}
                  disabled={readOnly}
                />
              </CardContent>
            </Card>

            {/* Scoring Config */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Scoring Configuration</CardTitle>
                <CardDescription>
                  Define the metrics the judge should output and the threshold required to pass.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Metrics *</Label>
                    {!readOnly && (
                      <Button variant="outline" size="sm" onClick={handleAddMetric}>
                        <Plus className="h-4 w-4 mr-2" />
                        Add Metric
                      </Button>
                    )}
                  </div>

                  {metrics.length === 0 ? (
                    <div className="text-sm text-muted-foreground border border-dashed rounded-lg p-6 text-center">
                      No metrics yet. Click <span className="font-medium">Add Metric</span> to start.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {metrics.map((metric, index) => (
                        <div
                          key={index}
                          className="flex items-start gap-3 p-3 border rounded-lg bg-muted/20"
                        >
                          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                            <div className="space-y-1.5 lg:col-span-1">
                              <Label className="text-xs">Name *</Label>
                              <Input
                                value={metric.name}
                                onChange={(e) => handleMetricChange(index, 'name', e.target.value)}
                                placeholder="e.g., accuracy"
                                disabled={readOnly}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="space-y-1.5 sm:col-span-1 lg:col-span-2">
                              <Label className="text-xs">Description</Label>
                              <Input
                                value={metric.description || ''}
                                onChange={(e) =>
                                  handleMetricChange(index, 'description', e.target.value)
                                }
                                placeholder="e.g., Overall accuracy score"
                                disabled={readOnly}
                                className="h-8 text-sm"
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-3 lg:col-span-1">
                              <div className="space-y-1.5">
                                <Label className="text-xs">Weight</Label>
                                <Input
                                  type="number"
                                  value={metric.weight}
                                  onChange={(e) =>
                                    handleMetricChange(
                                      index,
                                      'weight',
                                      parseFloat(e.target.value) || 0,
                                    )
                                  }
                                  min="0"
                                  max="1"
                                  step="0.1"
                                  disabled={readOnly}
                                  className="h-8 text-sm"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs">Scale</Label>
                                <Input
                                  type="number"
                                  value={metric.scale}
                                  onChange={(e) =>
                                    handleMetricChange(
                                      index,
                                      'scale',
                                      parseInt(e.target.value) || 100,
                                    )
                                  }
                                  disabled={readOnly}
                                  className="h-8 text-sm"
                                />
                              </div>
                            </div>
                          </div>
                          {!readOnly && metrics.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleRemoveMetric(index)}
                              aria-label={`Remove metric ${metric.name || index + 1}`}
                              className="mt-5 shrink-0"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5 max-w-xs">
                  <Label htmlFor="passThreshold">Pass Threshold (0–100)</Label>
                  <Input
                    id="passThreshold"
                    type="number"
                    value={passThreshold}
                    onChange={(e) => setPassThreshold(parseInt(e.target.value) || 70)}
                    min="0"
                    max="100"
                    disabled={readOnly}
                  />
                  <p className="text-xs text-muted-foreground">
                    Evaluations scoring at or above this value pass.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Latest pane houses ONLY the editor surface. The History pane
                below is the single home for prior-version inspection. */}
          </main>
        </div>
          </TabsContent>

          {isEditMode && (
            <TabsContent value="history" className="mt-0">
              {evaluatorId && (
                <EvaluatorVersionHistory
                  evaluatorId={evaluatorId}
                  isSystem={isSystem}
                />
              )}
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
};
