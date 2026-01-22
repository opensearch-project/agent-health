/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Check, Loader2, FileJson } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LabelPicker } from '@/components/ui/label-picker';
import { TestCase, AgentContextItem } from '@/types';
import { asyncTestCaseStorage } from '@/services/storage';
import {
  ValidationError,
  validateTestCaseJson,
  validateTestCasesArrayJson,
  serializeFormToJson,
} from '@/lib/testCaseValidation';
import { parseLabels } from '@/lib/labels';

interface TestCaseEditorProps {
  testCase: TestCase | null; // null = create mode
  onSave: (testCase: TestCase) => void;
  onBulkSave?: (result: { created: number; errors: boolean }) => void;
  onCancel: () => void;
}

type EditorMode = 'form' | 'json';

export const TestCaseEditor: React.FC<TestCaseEditorProps> = ({
  testCase,
  onSave,
  onBulkSave,
  onCancel,
}) => {
  // Form state
  const [name, setName] = useState(testCase?.name || '');
  const [description, setDescription] = useState(testCase?.description || '');
  const [labels, setLabels] = useState<string[]>(testCase?.labels || []);
  const [initialPrompt, setInitialPrompt] = useState(testCase?.initialPrompt || '');
  const [context, setContext] = useState<AgentContextItem[]>(testCase?.context || []);
  const [expectedOutcomes, setExpectedOutcomes] = useState<string[]>(
    testCase?.expectedOutcomes || ['']
  );

  // Editor mode state
  const [editorMode, setEditorMode] = useState<EditorMode>('form');
  const [jsonContent, setJsonContent] = useState<string>('');
  const [jsonErrors, setJsonErrors] = useState<ValidationError[]>([]);
  const [bulkImportResults, setBulkImportResults] = useState<{ created: number; failed: number } | null>(null);

  // Get existing labels for suggestions
  const [existingLabels, setExistingLabels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    asyncTestCaseStorage.getLabels().then(setExistingLabels);
  }, []);

  const handleAddContext = () => {
    setContext([...context, { description: '', value: '' }]);
  };

  const handleUpdateContext = (index: number, field: 'description' | 'value', value: string) => {
    const updated = [...context];
    updated[index] = { ...updated[index], [field]: value };
    setContext(updated);
  };

  const handleRemoveContext = (index: number) => {
    setContext(context.filter((_, i) => i !== index));
  };

  // Expected Outcomes handlers
  const handleAddOutcome = () => {
    setExpectedOutcomes([...expectedOutcomes, '']);
  };

  const handleUpdateOutcome = (index: number, value: string) => {
    const updated = [...expectedOutcomes];
    updated[index] = value;
    setExpectedOutcomes(updated);
  };

  const handleRemoveOutcome = (index: number) => {
    if (expectedOutcomes.length > 1) {
      setExpectedOutcomes(expectedOutcomes.filter((_, i) => i !== index));
    }
  };

  // Mode switching handlers
  const handleModeChange = (newMode: string) => {
    const mode = newMode as EditorMode;
    setJsonErrors([]);
    setBulkImportResults(null);

    if (mode === 'json' && editorMode === 'form') {
      // Form -> JSON: Serialize current form state
      // Extract legacy fields from labels for JSON compatibility
      const parsed = parseLabels(labels);
      const json = serializeFormToJson({
        name,
        description,
        category: parsed.category || 'General',
        subcategory: parsed.subcategory || '',
        difficulty: parsed.difficulty || 'Medium',
        initialPrompt,
        context,
        expectedOutcomes,
      });
      setJsonContent(json);
    } else if (mode === 'form' && editorMode === 'json') {
      // JSON -> Form: Best-effort populate, don't block on validation errors
      if (jsonContent.trim()) {
        try {
          const parsed = JSON.parse(jsonContent);
          // Block only for arrays (can't represent in form)
          if (Array.isArray(parsed)) {
            setJsonErrors([{ path: '', message: 'Cannot switch to Form mode with an array. Save the array first or edit as single object.', type: 'error' }]);
            return;
          }
          // Best-effort populate form - use defaults for missing/invalid fields
          setName(parsed.name || '');
          setDescription(parsed.description || '');
          // Handle labels - use provided labels or build from legacy fields
          if (Array.isArray(parsed.labels) && parsed.labels.length > 0) {
            setLabels(parsed.labels);
          } else {
            // Build labels from legacy fields
            const builtLabels: string[] = [];
            if (parsed.difficulty) builtLabels.push(`difficulty:${parsed.difficulty}`);
            if (parsed.category) builtLabels.push(`category:${parsed.category}`);
            if (parsed.subcategory) builtLabels.push(`subcategory:${parsed.subcategory}`);
            setLabels(builtLabels);
          }
          setInitialPrompt(parsed.initialPrompt || '');
          setContext(Array.isArray(parsed.context) ? parsed.context : []);
          setExpectedOutcomes(
            Array.isArray(parsed.expectedOutcomes) && parsed.expectedOutcomes.length > 0
              ? parsed.expectedOutcomes
              : ['']
          );
        } catch {
          // Invalid JSON structure - reset form to defaults
          setName('');
          setDescription('');
          setLabels([]);
          setInitialPrompt('');
          setContext([]);
          setExpectedOutcomes(['']);
        }
      }
    }

    setEditorMode(mode);
  };

  const handleJsonChange = (value: string) => {
    setJsonContent(value);
    setJsonErrors([]);
    setBulkImportResults(null);
  };

  const handleFormatJson = () => {
    try {
      const parsed = JSON.parse(jsonContent);
      setJsonContent(JSON.stringify(parsed, null, 2));
      setJsonErrors([]);
    } catch (e) {
      setJsonErrors([{ path: '', message: `Invalid JSON: ${(e as Error).message}`, type: 'error' }]);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setJsonErrors([]);

    try {
      if (editorMode === 'form') {
        // Form mode: use labels directly
        const filteredOutcomes = expectedOutcomes.filter(o => o.trim());

        if (testCase) {
          // Update existing
          const updated = await asyncTestCaseStorage.update(testCase.id, {
            name,
            description,
            labels,
            initialPrompt,
            context,
            expectedOutcomes: filteredOutcomes,
          });
          if (updated) {
            onSave(updated);
          }
        } else {
          // Create new
          const created = await asyncTestCaseStorage.create({
            name,
            description,
            labels,
            initialPrompt,
            context,
            expectedOutcomes: filteredOutcomes,
          });
          onSave(created);
        }
      } else if (editorMode === 'json') {
        // JSON mode: handles both single object and array
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonContent);
        } catch (e) {
          setJsonErrors([{ path: '', message: `Invalid JSON: ${(e as Error).message}`, type: 'error' }]);
          return;
        }

        const isArray = Array.isArray(parsed);

        if (isArray) {
          // Bulk import: array of test cases
          const result = validateTestCasesArrayJson(parsed);
          if (!result.valid || !result.data) {
            setJsonErrors(result.errors);
            return;
          }

          const testCasesToCreate = result.data.map(tc => ({
            name: tc.name,
            description: tc.description || '',
            category: tc.category,
            subcategory: tc.subcategory || undefined,
            difficulty: tc.difficulty,
            initialPrompt: tc.initialPrompt,
            context: (tc.context || []) as AgentContextItem[],
            expectedOutcomes: tc.expectedOutcomes || [],
          }));

          const bulkResult = await asyncTestCaseStorage.bulkCreate(testCasesToCreate);
          const failed = testCasesToCreate.length - bulkResult.created;
          setBulkImportResults({ created: bulkResult.created, failed });

          if (onBulkSave) {
            onBulkSave(bulkResult);
          }

          // If successful and no failures, close the modal after a short delay
          if (bulkResult.created > 0 && failed === 0) {
            setTimeout(() => {
              onCancel();
            }, 1500);
          }
        } else {
          // Single test case
          const result = validateTestCaseJson(parsed);
          if (!result.valid || !result.data) {
            setJsonErrors(result.errors);
            return;
          }

          const data = result.data;
          if (testCase) {
            // Update existing
            const updated = await asyncTestCaseStorage.update(testCase.id, {
              name: data.name,
              description: data.description || '',
              category: data.category,
              subcategory: data.subcategory || undefined,
              difficulty: data.difficulty,
              initialPrompt: data.initialPrompt,
              context: (data.context || []) as AgentContextItem[],
              expectedOutcomes: data.expectedOutcomes || [],
            });
            if (updated) {
              onSave(updated);
            }
          } else {
            // Create new
            const created = await asyncTestCaseStorage.create({
              name: data.name,
              description: data.description || '',
              category: data.category,
              subcategory: data.subcategory || undefined,
              difficulty: data.difficulty,
              initialPrompt: data.initialPrompt,
              context: (data.context || []) as AgentContextItem[],
              expectedOutcomes: data.expectedOutcomes || [],
            });
            onSave(created);
          }
        }
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Validation for each mode
  const hasValidOutcome = expectedOutcomes.some(o => o.trim());
  const canSaveForm = name.trim() && initialPrompt.trim() && hasValidOutcome && !isSaving;
  const canSaveJson = jsonContent.trim() && jsonErrors.length === 0 && !isSaving;
  const canSave = editorMode === 'form' ? canSaveForm : canSaveJson;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle>
            {testCase ? 'Edit Eval' : 'Create Eval'}
          </CardTitle>
          <Button variant="ghost" size="icon" onClick={onCancel}>
            <X size={18} />
          </Button>
        </CardHeader>

        {/* Mode Tabs */}
        <div className="px-6 pb-2">
          <Tabs value={editorMode} onValueChange={handleModeChange}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="form" className="gap-1">
                Form
              </TabsTrigger>
              <TabsTrigger value="json" className="gap-1">
                <FileJson size={14} />
                JSON
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <CardContent className="flex-1 overflow-hidden p-0">
          {/* Form Mode */}
          {editorMode === 'form' && (
          <ScrollArea className="h-[60vh] p-6">
            <div className="space-y-6">
              {/* Basic Info */}
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Name *</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g., Service Discovery Test"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Description</Label>
                  <Textarea
                    id="description"
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="Describe what this eval validates..."
                    rows={2}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Labels</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Add labels to categorize this test case (e.g., difficulty, category, tags)
                  </p>
                  <LabelPicker
                    value={labels}
                    onChange={setLabels}
                    suggestions={existingLabels}
                    placeholder="Add labels..."
                  />
                </div>
              </div>

              {/* Initial Prompt */}
              <div className="space-y-2">
                <Label htmlFor="prompt">Initial Prompt *</Label>
                <Textarea
                  id="prompt"
                  value={initialPrompt}
                  onChange={e => setInitialPrompt(e.target.value)}
                  placeholder="The user query to send to the agent..."
                  rows={3}
                />
              </div>

              {/* Context */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Context (optional)</Label>
                  <Button variant="outline" size="sm" onClick={handleAddContext}>
                    <Plus size={14} className="mr-1" />
                    Add Context
                  </Button>
                </div>
                {context.length > 0 ? (
                  <div className="space-y-2">
                    {context.map((item, index) => (
                      <Card key={index} className="bg-muted/30">
                        <CardContent className="p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">Context {index + 1}</span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleRemoveContext(index)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          </div>
                          <Input
                            value={item.description}
                            onChange={e => handleUpdateContext(index, 'description', e.target.value)}
                            placeholder="Description (e.g., Current cluster state)"
                          />
                          <Textarea
                            value={item.value}
                            onChange={e => handleUpdateContext(index, 'value', e.target.value)}
                            placeholder="Value (JSON stringified data)"
                            rows={2}
                          />
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No context items added</p>
                )}
              </div>

              {/* Expected Outcomes */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Expected Outcomes *</Label>
                  <Button variant="outline" size="sm" onClick={handleAddOutcome}>
                    <Plus size={14} className="mr-1" />
                    Add Outcome
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Define what the agent should accomplish. At least one outcome is required.
                </p>
                <div className="space-y-2">
                  {expectedOutcomes.map((outcome, index) => (
                    <Card key={index} className="bg-muted/30">
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">Outcome {index + 1}</span>
                          {expectedOutcomes.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleRemoveOutcome(index)}
                            >
                              <Trash2 size={12} />
                            </Button>
                          )}
                        </div>
                        <Textarea
                          value={outcome}
                          onChange={e => handleUpdateOutcome(index, e.target.value)}
                          placeholder="e.g., Should query CloudWatch alarms and identify the root cause"
                          rows={2}
                        />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            </div>
          </ScrollArea>
          )}

          {/* JSON Mode */}
          {editorMode === 'json' && (
            <div className="h-[60vh] p-6 flex flex-col">
              <div className="flex items-center justify-between mb-2">
                <Label className="text-sm text-muted-foreground">
                  {testCase
                    ? 'Edit test case as JSON'
                    : 'Paste a single object {...} or array [{...}, {...}] to bulk import'}
                </Label>
                <Button variant="outline" size="sm" onClick={handleFormatJson}>
                  Format JSON
                </Button>
              </div>
              <Textarea
                value={jsonContent}
                onChange={(e) => handleJsonChange(e.target.value)}
                className="flex-1 font-mono text-sm resize-none"
                placeholder={'{\n  "name": "Eval Name",\n  "category": "RCA",\n  "difficulty": "Medium",\n  "initialPrompt": "Your prompt here",\n  "expectedOutcomes": ["Expected outcome 1"]\n}'}
              />

              {/* Validation Errors */}
              {jsonErrors.length > 0 && (
                <div className="mt-3 bg-red-900/20 border border-red-500/50 rounded-md p-3">
                  <div className="text-red-400 text-sm font-medium mb-1">Validation Errors</div>
                  <div className="max-h-24 overflow-y-auto">
                    {jsonErrors.map((err, i) => (
                      <div key={i} className="text-red-300 text-xs">
                        {err.path && <span className="text-red-400">{err.path}: </span>}
                        {err.message}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Bulk Import Results */}
              {bulkImportResults && (
                <div className={`mt-3 rounded-md p-3 ${
                  bulkImportResults.failed > 0
                    ? 'bg-yellow-900/20 border border-yellow-500/50'
                    : 'bg-blue-900/20 border border-opensearch-blue/50'
                }`}>
                  <div className={`text-sm font-medium ${
                    bulkImportResults.failed > 0 ? 'text-yellow-400' : 'text-opensearch-blue'
                  }`}>
                    {bulkImportResults.created > 0
                      ? `Successfully created ${bulkImportResults.created} test case${bulkImportResults.created > 1 ? 's' : ''}`
                      : 'No test cases were created'}
                    {bulkImportResults.failed > 0 &&
                      ` (${bulkImportResults.failed} failed)`}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>

        {/* Footer */}
        <div className="p-4 border-t flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!canSave}
            className="bg-opensearch-blue hover:bg-blue-600"
          >
            {isSaving ? (
              <Loader2 size={16} className="mr-1 animate-spin" />
            ) : (
              <Check size={16} className="mr-1" />
            )}
            {testCase ? 'Save Changes' : 'Save'}
          </Button>
        </div>
      </Card>
    </div>
  );
};
