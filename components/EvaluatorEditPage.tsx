/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Save, X, Plus, Trash2, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { ENV_CONFIG } from '@/lib/config';
import type { Evaluator, ScoringMetric } from '@/types';

export const EvaluatorEditPage: React.FC = () => {
  const navigate = useNavigate();
  const { evaluatorId } = useParams();
  const isEditMode = !!evaluatorId;
  const [loading, setLoading] = useState(isEditMode);
  const [saving, setSaving] = useState(false);
  const [isSystem, setIsSystem] = useState(false);

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

      navigate('/evaluators');
    } catch (error: any) {
      console.error('Error saving evaluator:', error);
      alert(error.message || 'Failed to save evaluator');
    } finally {
      setSaving(false);
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
        <div className="text-center py-12">Loading evaluator...</div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate('/evaluators')}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-3xl font-bold">
              {isEditMode ? (isSystem ? 'View Evaluator' : 'Edit Evaluator') : 'New Evaluator'}
            </h1>
            {isSystem && (
              <p className="text-sm text-muted-foreground mt-1">
                System evaluators are read-only. Duplicate to create a custom version.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate('/evaluators')}>
            <X className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          {!isSystem && (
            <Button onClick={handleSave} disabled={saving}>
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          )}
        </div>
      </div>

      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle>Basic Information</CardTitle>
          <CardDescription>Name and description for this evaluator</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Factuality Checker"
              disabled={isSystem}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this evaluator assesses..."
              rows={3}
              disabled={isSystem}
            />
          </div>
        </CardContent>
      </Card>

      {/* System Prompt */}
      <Card>
        <CardHeader>
          <CardTitle>System Prompt *</CardTitle>
          <CardDescription>
            The instructions for the LLM judge. Define evaluation criteria and output format.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder="You are an expert evaluator..."
            rows={12}
            className="font-mono text-sm"
            disabled={isSystem}
          />
        </CardContent>
      </Card>

      {/* Scoring Config */}
      <Card>
        <CardHeader>
          <CardTitle>Scoring Configuration</CardTitle>
          <CardDescription>Define metrics and pass threshold</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label>Metrics *</Label>
              {!isSystem && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAddMetric}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Metric
                </Button>
              )}
            </div>

            {metrics.map((metric, index) => (
              <div key={index} className="flex items-start gap-3 p-3 border rounded-lg">
                <div className="flex-1 grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label className="text-xs">Name *</Label>
                    <Input
                      value={metric.name}
                      onChange={(e) => handleMetricChange(index, 'name', e.target.value)}
                      placeholder="e.g., accuracy"
                      disabled={isSystem}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Description</Label>
                    <Input
                      value={metric.description || ''}
                      onChange={(e) => handleMetricChange(index, 'description', e.target.value)}
                      placeholder="e.g., Overall accuracy score"
                      disabled={isSystem}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Weight</Label>
                    <Input
                      type="number"
                      value={metric.weight}
                      onChange={(e) => handleMetricChange(index, 'weight', parseFloat(e.target.value) || 0)}
                      min="0"
                      max="1"
                      step="0.1"
                      disabled={isSystem}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Scale</Label>
                    <Input
                      type="number"
                      value={metric.scale}
                      onChange={(e) => handleMetricChange(index, 'scale', parseInt(e.target.value) || 100)}
                      disabled={isSystem}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
                {!isSystem && metrics.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveMetric(index)}
                    className="mt-6"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="passThreshold">Pass Threshold (0-100)</Label>
            <Input
              id="passThreshold"
              type="number"
              value={passThreshold}
              onChange={(e) => setPassThreshold(parseInt(e.target.value) || 70)}
              min="0"
              max="100"
              disabled={isSystem}
            />
            <p className="text-xs text-muted-foreground">
              Evaluations with scores above this threshold will pass
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Inference Config */}
      <Card>
        <CardHeader>
          <CardTitle>Inference Configuration (Optional)</CardTitle>
          <CardDescription>
            Override default judge settings for this evaluator
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={provider || 'default'}
                onValueChange={(val) => setProvider(val === 'default' ? '' : val)}
                disabled={isSystem}
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
            <div className="space-y-2">
              <Label htmlFor="modelId">Model ID</Label>
              <Input
                id="modelId"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                placeholder="Optional override"
                disabled={isSystem}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="temperature">Temperature</Label>
              <Input
                id="temperature"
                type="number"
                value={temperature}
                onChange={(e) => setTemperature(parseFloat(e.target.value) || 0.1)}
                min="0"
                max="1"
                step="0.1"
                disabled={isSystem}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxTokens">Max Tokens</Label>
              <Input
                id="maxTokens"
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(parseInt(e.target.value) || 4096)}
                min="256"
                max="8192"
                step="256"
                disabled={isSystem}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
