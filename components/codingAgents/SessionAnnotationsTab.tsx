/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @experimental Session metadata / annotations tab.
 * Uses the generic session metadata API (GET/PUT) — annotations are stored
 * as an array inside the metadata doc.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { SessionMetadata } from '@/types';
import { getSessionMetadata, putSessionMetadata } from '@/services/client/sessionAnnotationsApi';

interface Annotation {
  id: string;
  text: string;
  tags?: string[];
  severity?: 'info' | 'warning' | 'critical';
  timestamp: string;
  linkedMessageIndex?: number;
}

const PRESET_TAGS = ['bug', 'hallucination', 'performance', 'interesting', 'regression', 'tool-failure'];
const SEVERITY_COLORS: Record<string, string> = {
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  critical: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
};
const STATUS_OPTIONS = ['normal', 'interesting', 'problematic', 'resolved'] as const;

interface Props {
  agentKind: string;
  sessionId: string;
  onLinkedMessageClick?: (index: number) => void;
}

export default function SessionAnnotationsTab({ agentKind, sessionId, onLinkedMessageClick }: Props) {
  const [meta, setMeta] = useState<SessionMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [severity, setSeverity] = useState<'info' | 'warning' | 'critical'>('info');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    getSessionMetadata(agentKind, sessionId)
      .then(setMeta)
      .catch(() => setMeta(null))
      .finally(() => setLoading(false));
  }, [agentKind, sessionId]);

  useEffect(() => { refresh(); }, [refresh]);

  const annotations: Annotation[] = Array.isArray(meta?.annotations) ? meta.annotations as Annotation[] : [];
  const status = (typeof meta?.status === 'string' ? meta.status : 'normal');

  const save = async (updates: Record<string, unknown>) => {
    setSaving(true);
    try {
      const result = await putSessionMetadata(agentKind, sessionId, updates);
      setMeta(result);
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = async () => {
    if (!text.trim()) return;
    const newAnnotation: Annotation = {
      id: `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: text.trim(),
      tags: selectedTags.length > 0 ? selectedTags : undefined,
      severity,
      timestamp: new Date().toISOString(),
    };
    await save({ annotations: [...annotations, newAnnotation] });
    setText('');
    setSelectedTags([]);
    setSeverity('info');
  };

  const handleDelete = async (id: string) => {
    await save({ annotations: annotations.filter(a => a.id !== id) });
  };

  const handleStatusChange = async (newStatus: string) => {
    await save({ status: newStatus });
  };

  const toggleTag = (tag: string) => {
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  if (loading) {
    return <div className="text-sm text-muted-foreground py-4 text-center">Loading...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground border border-dashed rounded px-2 py-1">
        <span className="font-medium text-amber-600 dark:text-amber-400">EXPERIMENTAL</span>
        <span>Session metadata &amp; annotations</span>
      </div>

      {/* Status */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Status:</span>
        <Select value={status} onValueChange={handleStatusChange}>
          <SelectTrigger className="w-36 h-7 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map(s => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Add annotation */}
      <div className="border rounded-md p-3 space-y-2 bg-muted/30">
        <textarea
          className="w-full border rounded px-3 py-2 text-sm bg-background resize-y min-h-[60px]"
          placeholder="Add a note..."
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleAdd(); }}
        />
        <div className="flex flex-wrap gap-1.5">
          {PRESET_TAGS.map(tag => (
            <button
              key={tag}
              onClick={() => toggleTag(tag)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                selectedTags.includes(tag)
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-border hover:border-primary/50'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Select value={severity} onValueChange={v => setSeverity(v as any)}>
            <SelectTrigger className="w-28 h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" onClick={handleAdd} disabled={!text.trim() || saving} className="ml-auto h-7 text-xs">
            {saving ? 'Saving...' : 'Add Note'}
          </Button>
        </div>
      </div>

      {/* Annotations list */}
      {annotations.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No annotations yet.</p>
      ) : (
        <div className="space-y-2">
          {annotations.map((ann) => (
            <div key={ann.id} className="border rounded-md p-3 text-sm space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  {ann.severity && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${SEVERITY_COLORS[ann.severity] || ''}`}>
                      {ann.severity}
                    </span>
                  )}
                  {ann.tags?.map(tag => (
                    <Badge key={tag} variant="secondary" className="text-[10px] px-1.5 py-0">{tag}</Badge>
                  ))}
                </div>
                <button onClick={() => handleDelete(ann.id)} aria-label="Delete annotation" title="Delete annotation" className="text-muted-foreground hover:text-red-500 text-xs shrink-0">&times;</button>
              </div>
              <p className="whitespace-pre-wrap text-xs">{ann.text}</p>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>{new Date(ann.timestamp).toLocaleString()}</span>
                {ann.linkedMessageIndex !== undefined && onLinkedMessageClick && (
                  <button onClick={() => onLinkedMessageClick(ann.linkedMessageIndex!)} className="text-blue-500 hover:underline">
                    Message #{ann.linkedMessageIndex + 1}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
