/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Eye, Pencil, Copy, RefreshCw, FlaskConical, Shield, Target, Brain, ListChecks } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ENV_CONFIG } from '@/lib/config';
import type { Evaluator } from '@/types';

const EVALUATOR_ICONS: Record<string, React.ComponentType<any>> = {
  'system-rca-default': FlaskConical,
  'system-factuality': Target,
  'system-tool-usage': ListChecks,
  'system-reasoning-depth': Brain,
  'system-safety': Shield,
};

export const EvaluatorsPage: React.FC = () => {
  const navigate = useNavigate();
  const [evaluators, setEvaluators] = useState<Evaluator[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [evaluatorToDelete, setEvaluatorToDelete] = useState<Evaluator | null>(null);
  const [systemCount, setSystemCount] = useState(0);
  const [customCount, setCustomCount] = useState(0);

  const loadEvaluators = async () => {
    try {
      setLoading(true);
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`);
      if (!response.ok) {
        throw new Error(`Failed to load evaluators: ${response.statusText}`);
      }
      const data = await response.json();
      const allEvaluators = data.evaluators || [];
      setEvaluators(allEvaluators);
      setSystemCount(allEvaluators.filter((e: any) => e.isSystem).length);
      setCustomCount(allEvaluators.filter((e: any) => !e.isSystem).length);
    } catch (error) {
      console.error('Error loading evaluators:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvaluators();
  }, []);

  const handleDelete = async () => {
    if (!evaluatorToDelete) return;

    try {
      const response = await fetch(
        `${ENV_CONFIG.backendUrl}/api/storage/evaluators/${evaluatorToDelete.id}`,
        { method: 'DELETE' }
      );

      if (!response.ok) {
        const error = await response.json();
        alert(error.error || 'Failed to delete evaluator');
        return;
      }

      await loadEvaluators();
      setDeleteDialogOpen(false);
      setEvaluatorToDelete(null);
    } catch (error) {
      console.error('Error deleting evaluator:', error);
      alert('Failed to delete evaluator');
    }
  };

  const handleDuplicate = async (evaluator: Evaluator) => {
    try {
      const response = await fetch(`${ENV_CONFIG.backendUrl}/api/storage/evaluators`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${evaluator.name} (Copy)`,
          description: evaluator.description,
          systemPrompt: evaluator.systemPrompt,
          scoringConfig: evaluator.scoringConfig,
          inferenceConfig: evaluator.inferenceConfig,
          tags: evaluator.tags,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to duplicate evaluator');
      }

      await loadEvaluators();
    } catch (error) {
      console.error('Error duplicating evaluator:', error);
      alert('Failed to duplicate evaluator');
    }
  };

  const getEvaluatorIcon = (evaluatorId: string) => {
    const Icon = EVALUATOR_ICONS[evaluatorId];
    return Icon ? <Icon className="h-5 w-5" /> : <FlaskConical className="h-5 w-5" />;
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Evaluators</h1>
          <p className="text-muted-foreground mt-1">
            Manage evaluation criteria and scoring methods for agent testing
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={loadEvaluators}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button onClick={() => navigate('/evaluators/new')}>
            <Plus className="h-4 w-4 mr-2" />
            New Evaluator
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Total Evaluators</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{evaluators.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">System Evaluators</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{systemCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Built-in templates</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Custom Evaluators</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{customCount}</div>
            <p className="text-xs text-muted-foreground mt-1">User-created</p>
          </CardContent>
        </Card>
      </div>

      {/* Evaluators List */}
      <Card>
        <CardHeader>
          <CardTitle>All Evaluators</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading evaluators...</div>
          ) : evaluators.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No evaluators found. Create one to get started.
            </div>
          ) : (
            <div className="space-y-3">
              {evaluators.map((evaluator) => (
                <div
                  key={evaluator.id}
                  className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent/50 transition-colors"
                >
                  <div className="flex items-center gap-4 flex-1">
                    <div className="flex-shrink-0">
                      {getEvaluatorIcon(evaluator.id)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold truncate">{evaluator.name}</h3>
                        {evaluator.isSystem && (
                          <Badge variant="secondary" className="text-xs">
                            System
                          </Badge>
                        )}
                        {evaluator.tags?.includes('default') && (
                          <Badge variant="outline" className="text-xs">
                            Default
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {evaluator.description}
                      </p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span>
                          {evaluator.scoringConfig?.metrics?.length || 0} metrics
                        </span>
                        <span>v{evaluator.currentVersion}</span>
                        {evaluator.inferenceConfig?.provider && (
                          <span className="capitalize">
                            {evaluator.inferenceConfig.provider}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate(`/evaluators/${evaluator.id}/edit`)}
                      title={evaluator.isSystem ? 'View details' : 'Edit evaluator'}
                    >
                      {evaluator.isSystem ? (
                        <Eye className="h-4 w-4" />
                      ) : (
                        <Pencil className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDuplicate(evaluator)}
                      title="Duplicate evaluator"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    {!evaluator.isSystem && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEvaluatorToDelete(evaluator);
                          setDeleteDialogOpen(true);
                        }}
                        title="Delete evaluator"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Evaluator</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{evaluatorToDelete?.name}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
