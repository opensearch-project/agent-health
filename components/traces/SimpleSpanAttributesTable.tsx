/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SimpleSpanAttributesTable
 *
 * Plain attributes table for a single span — used inside the bottom
 * span-details drawer on the Agent Traces page. Intentionally avoids the
 * curated INPUT / OUTPUT / DURATION / STATUS / SERVICE / MODEL sections
 * that SpanDetailsPanel surfaces; the user wants a flat, unbiased table
 * of every attribute on the span ("for now"), so this component renders
 * exactly that plus a tiny header strip with the core span identity.
 */

import React, { useMemo, useState } from 'react';
import { Span } from '@/types';
import { formatDuration } from '@/services/traces/utils';
import { Input } from '@/components/ui/input';
import { Search, Copy, Check } from 'lucide-react';

interface SimpleSpanAttributesTableProps {
  span: Span;
}

/**
 * Stringify any attribute value (including objects/arrays) into a
 * human-readable cell value.
 *
 * `mode='pretty'` (default) will additionally try to parse string values
 * that look like JSON (e.g. `gen_ai.tool.input` is often a serialized
 * payload like `'{"query":"x"}'`) and reformat them with 2-space indent.
 * `mode='raw'` returns string values verbatim and uses compact JSON for
 * objects/arrays — useful when copy-pasting into another tool.
 */
function valueToString(v: unknown, mode: 'pretty' | 'raw' = 'pretty'): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    if (mode === 'pretty') {
      const trimmed = v.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return JSON.stringify(JSON.parse(trimmed), null, 2);
        } catch {
          // Not actually JSON — fall through to the raw string.
        }
      }
    }
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v, mode === 'pretty' ? null : undefined, mode === 'pretty' ? 2 : undefined);
  } catch {
    return String(v);
  }
}

const SimpleSpanAttributesTable: React.FC<SimpleSpanAttributesTableProps> = ({ span }) => {
  const [filter, setFilter] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  // Default to pretty so JSON-shaped attribute strings (e.g. tool.input,
  // tool.output, request bodies dumped into attributes) come out indented.
  // Toggle to 'raw' to see what's literally on the span — useful when
  // copying into another tool that expects the original wire format.
  const [valueMode, setValueMode] = useState<'pretty' | 'raw'>('pretty');

  const duration = useMemo(
    () => new Date(span.endTime).getTime() - new Date(span.startTime).getTime(),
    [span]
  );

  // Flat sorted list of attribute entries. Sort alphabetically so users
  // can scan predictably; this is the "simple table" the user asked for.
  const entries = useMemo(() => {
    const attrs = span.attributes || {};
    const list = Object.entries(attrs).map(([k, v]) => ({
      key: k,
      value: valueToString(v, valueMode),
    }));
    list.sort((a, b) => a.key.localeCompare(b.key));
    return list;
  }, [span.attributes, valueMode]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return entries;
    const q = filter.toLowerCase();
    return entries.filter(
      (e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q)
    );
  }, [entries, filter]);

  const handleCopy = async (key: string, value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } catch (err) {
      // Best-effort copy; ignore failures silently in this read-only view.
      // eslint-disable-next-line no-console
      console.error('Copy failed', err);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Identity strip — bare minimum so users always know which span
          they're looking at. Everything else is in the table below.
          The right padding (pr-10) reserves space for the absolutely
          positioned close (X) button rendered by the parent drawer so
          it doesn't visually overlap the trailing "N attributes" text. */}
      <div className="flex items-center justify-between gap-3 pl-3 pr-10 py-2 border-b bg-muted/30 text-[11px] flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate" title={span.name}>{span.name}</span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono text-muted-foreground" title={span.spanId}>
            {span.spanId.slice(0, 12)}…
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="font-mono text-amber-700 dark:text-amber-400">
            {formatDuration(duration)}
          </span>
          {span.status && span.status !== 'UNSET' && (
            <>
              <span className="text-muted-foreground">·</span>
              <span
                className={
                  span.status === 'ERROR'
                    ? 'text-red-600 dark:text-red-400 font-medium'
                    : 'text-green-700 dark:text-green-400 font-medium'
                }
              >
                {span.status}
              </span>
            </>
          )}
        </div>
        <span className="text-muted-foreground">
          {entries.length} attribute{entries.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Filter input + Pretty/Raw toggle. Tables of 27+ rows benefit from
          a quick filter; the toggle controls how JSON-shaped values render
          (formatted vs. verbatim). */}
      <div className="px-3 py-2 border-b bg-background flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter attributes…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 pl-7 text-[11px]"
          />
        </div>
        <div className="inline-flex items-center rounded-md border bg-muted p-0.5 shrink-0">
          <button
            type="button"
            onClick={() => setValueMode('pretty')}
            className={`h-6 px-2 text-[10px] font-medium rounded-sm transition-colors ${
              valueMode === 'pretty' ? 'bg-background shadow-sm' : 'hover:bg-background/50 text-muted-foreground'
            }`}
            title="Pretty-print JSON-shaped values"
          >
            Pretty
          </button>
          <button
            type="button"
            onClick={() => setValueMode('raw')}
            className={`h-6 px-2 text-[10px] font-medium rounded-sm transition-colors ${
              valueMode === 'raw' ? 'bg-background shadow-sm' : 'hover:bg-background/50 text-muted-foreground'
            }`}
            title="Show values verbatim (no JSON reformatting)"
          >
            Raw
          </button>
        </div>
      </div>

      {/* Plain attributes table. Two columns: key, value. Long values wrap
          and use a monospace font so JSON / IDs stay readable. */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-muted-foreground">
            {entries.length === 0
              ? 'This span has no attributes.'
              : 'No attributes match the filter.'}
          </div>
        ) : (
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-background border-b">
              <tr>
                <th className="text-left font-medium text-muted-foreground px-3 py-1.5 w-[280px] min-w-[200px]">
                  Attribute
                </th>
                <th className="text-left font-medium text-muted-foreground px-3 py-1.5">
                  Value
                </th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ key, value }) => (
                <tr
                  key={key}
                  className="border-b last:border-b-0 hover:bg-muted/30 group align-top"
                >
                  <td className="px-3 py-1.5 font-mono text-foreground/90 break-all">{key}</td>
                  <td className="px-3 py-1.5 font-mono whitespace-pre-wrap break-words">
                    {value}
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <button
                      onClick={() => handleCopy(key, value)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted-foreground/20"
                      aria-label={`Copy value of ${key}`}
                      title="Copy value"
                    >
                      {copiedKey === key ? (
                        <Check size={11} className="text-green-600" />
                      ) : (
                        <Copy size={11} className="text-muted-foreground" />
                      )}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default SimpleSpanAttributesTable;
