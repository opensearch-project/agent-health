/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PrettyContent — renders a trajectory step's content (tool args, tool
 * result, JSON responses) as something readable instead of an escaped blob.
 *
 * The value is normalised by `lib/trajectory/prettifyContent` (envelope
 * unwrapping, nested JSON-string parsing) and then shown as:
 *
 *   - **Tree**: a collapsible JSON tree, expanded two levels by default, with
 *     expand-all / collapse-all, per-node toggles, typed colouring and
 *     soft-wrapped long strings. Children are rendered lazily (collapsed
 *     nodes render nothing below them) and capped per node with a
 *     "show more" control, so a huge payload never freezes the page.
 *   - **Table**: offered when the value (or a single array-valued key of the
 *     root object) is a homogeneous array of objects — search hits, ranked
 *     results — columns = union of keys, first 50 rows, cells truncated with
 *     a title tooltip.
 *   - **Raw**: the original string, untouched.
 *
 * A one-line summary header (`object · 6 keys`, `table · 20 rows × 7 cols`)
 * sits above the body so the shape is obvious before anything is expanded.
 * All controls are real `<button>`s (keyboard-operable, `aria-pressed` /
 * `aria-expanded`).
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Markdown } from '@/components/ui/markdown';
import {
  NormalizedContent,
  TabularShape,
  detectTabular,
  formatScalar,
  normalizeStepContent,
  stringifyPretty,
  summarizeValue,
  typeOfValue,
} from '@/lib/trajectory/prettifyContent';

export type PrettyMode = 'tree' | 'table' | 'raw' | 'text';

export interface PrettyContentProps {
  /** The step content: persisted string or already-parsed object (tool args). */
  content: string | unknown;
  /**
   * The original string for the Raw toggle. Defaults to the stringified
   * `content`; pass `step.content` when `content` is `step.toolArgs`.
   */
  raw?: string;
  /** Levels expanded by default in the tree. Default 2. */
  defaultExpandedDepth?: number;
  className?: string;
  /** data-testid prefix; children use `<testId>-summary`, `<testId>-tree` … */
  testId?: string;
}

/** Children rendered per container node before a "show more" control. */
const CHILD_PAGE = 100;
/** Rows rendered per table page. */
const TABLE_PAGE = 50;
/** Strings longer than this are clipped in the tree until clicked. */
const LONG_STRING = 400;
/** Cell text longer than this is truncated (full value in the title). */
const CELL_MAX = 80;

const TYPE_COLOR: Record<string, string> = {
  string: 'text-emerald-700 dark:text-emerald-400',
  number: 'text-sky-700 dark:text-sky-400',
  boolean: 'text-amber-700 dark:text-amber-400',
  null: 'text-muted-foreground italic',
  undefined: 'text-muted-foreground italic',
};

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/** 'default' = depth rule, 'all' / 'none' = user pressed expand/collapse all. */
type ExpandMode = 'default' | 'all' | 'none';

interface TreeContext {
  mode: ExpandMode;
  overrides: Map<string, boolean>;
  toggle: (path: string, depth: number) => void;
  defaultDepth: number;
}

function isExpanded(ctx: TreeContext, path: string, depth: number): boolean {
  const o = ctx.overrides.get(path);
  if (o !== undefined) return o;
  if (ctx.mode === 'all') return true;
  if (ctx.mode === 'none') return false;
  return depth < ctx.defaultDepth;
}

const ScalarValue: React.FC<{ value: unknown }> = ({ value }) => {
  const [full, setFull] = useState(false);
  const type = typeOfValue(value);
  const text = formatScalar(value);
  const long = type === 'string' && text.length > LONG_STRING && !full;
  return (
    <span className={cn('break-words whitespace-pre-wrap', TYPE_COLOR[type])}>
      {long ? text.slice(0, LONG_STRING) + '…' : text}
      {type === 'string' && text.length > LONG_STRING && (
        <button
          type="button"
          onClick={() => setFull((f) => !f)}
          className="ml-1 text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
        >
          {full ? 'less' : `more (${text.length} chars)`}
        </button>
      )}
    </span>
  );
};

interface NodeProps {
  keyLabel?: string;
  value: unknown;
  depth: number;
  path: string;
  ctx: TreeContext;
}

const JsonNode: React.FC<NodeProps> = ({ keyLabel, value, depth, path, ctx }) => {
  const type = typeOfValue(value);
  const [page, setPage] = useState(1);
  const container = type === 'object' || type === 'array';

  const label =
    keyLabel !== undefined ? (
      <span className="text-foreground/80">{keyLabel}</span>
    ) : null;

  if (!container) {
    return (
      <div className="flex gap-1 leading-5" style={{ paddingLeft: depth * 14 }}>
        <span className="w-[14px] flex-shrink-0" />
        {label}
        {label && <span className="text-muted-foreground">:</span>}
        <ScalarValue value={value} />
      </div>
    );
  }

  const open = isExpanded(ctx, path, depth);
  const bracketOpen = type === 'array' ? '[' : '{';
  const bracketClose = type === 'array' ? ']' : '}';
  const count = type === 'array' ? (value as unknown[]).length : Object.keys(value as object).length;
  // Only pay for the shape scan when the node is collapsed, and once per value.
  const summary = useMemo(() => (open ? '' : summarizeValue(value)), [open, value]);
  const shown: Array<[string, unknown]> = !open
    ? []
    : type === 'array'
      ? (value as unknown[]).slice(0, page * CHILD_PAGE).map((v, i) => [String(i), v] as [string, unknown])
      : Object.entries(value as Record<string, unknown>).slice(0, page * CHILD_PAGE);

  return (
    <div>
      <div className="flex gap-1 leading-5" style={{ paddingLeft: depth * 14 }}>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${keyLabel ?? 'root'}`}
          onClick={() => ctx.toggle(path, depth)}
          className="w-[14px] h-5 flex-shrink-0 inline-flex items-center justify-center text-muted-foreground hover:text-foreground rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {count === 0 ? null : open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {label}
        {label && <span className="text-muted-foreground">:</span>}
        <span className="text-muted-foreground">
          {bracketOpen}
          {!open && (
            <>
              <span className="mx-1 text-[10px] text-muted-foreground/70 not-italic">{summary}</span>
              {bracketClose}
            </>
          )}
          {open && count === 0 && bracketClose}
        </span>
      </div>
      {open && count > 0 && (
        <>
          {shown.map(([k, v]) => (
            <JsonNode key={k} keyLabel={k} value={v} depth={depth + 1} path={`${path}/${k}`} ctx={ctx} />
          ))}
          {count > shown.length && (
            <div style={{ paddingLeft: (depth + 1) * 14 + 14 }} className="leading-5">
              <button
                type="button"
                onClick={() => setPage((p) => p + 1)}
                className="text-[11px] text-opensearch-blue hover:underline"
              >
                show {Math.min(CHILD_PAGE, count - shown.length)} more of {count - shown.length} remaining…
              </button>
            </div>
          )}
          <div className="leading-5 text-muted-foreground" style={{ paddingLeft: depth * 14 + 14 }}>
            {bracketClose}
          </div>
        </>
      )}
    </div>
  );
};

/** Does any direct child of this container hold a non-empty container? */
function hasNestedContainer(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.some((c) => typeof c === 'object' && c !== null && Object.keys(c as object).length > 0);
}

interface JsonTreeProps {
  value: unknown;
  defaultDepth: number;
  testId?: string;
}

export const JsonTree: React.FC<JsonTreeProps> = ({ value, defaultDepth, testId }) => {
  const [mode, setMode] = useState<ExpandMode>('default');
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());

  const toggle = useCallback(
    (path: string, depth: number) => {
      setOverrides((prev) => {
        const next = new Map(prev);
        // Compute the current state from the *previous* override / mode so a
        // toggle always flips what the user sees. `depth` is passed in rather
        // than derived from the path — keys may themselves contain '/'.
        const current = prev.has(path)
          ? (prev.get(path) as boolean)
          : mode === 'all'
            ? true
            : mode === 'none'
              ? false
              : depth < defaultDepth;
        next.set(path, !current);
        return next;
      });
    },
    [mode, defaultDepth]
  );

  const setAll = (m: ExpandMode) => {
    setMode(m);
    setOverrides(new Map());
  };

  const ctx: TreeContext = { mode, overrides, toggle, defaultDepth };
  // A flat value (no nested containers) has nothing to expand/collapse.
  const hasNested = useMemo(() => hasNestedContainer(value), [value]);

  return (
    <div data-testid={testId} className="font-mono text-xs">
      {hasNested && (
      <div className="flex items-center gap-2 mb-1 text-[11px]">
        <button
          type="button"
          onClick={() => setAll('all')}
          className="text-muted-foreground hover:text-foreground underline decoration-dotted"
        >
          expand all
        </button>
        <button
          type="button"
          onClick={() => setAll('none')}
          className="text-muted-foreground hover:text-foreground underline decoration-dotted"
        >
          collapse all
        </button>
      </div>
      )}
      <JsonNode value={value} depth={0} path="" ctx={ctx} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function cellText(v: unknown): { text: string; full: string; type: string } {
  const type = typeOfValue(v);
  if (v === undefined) return { text: '', full: '', type };
  const full = type === 'object' || type === 'array' ? stringifyPretty(v) : typeof v === 'string' ? v : String(v);
  const oneLine = full.replace(/\s+/g, ' ');
  const text = oneLine.length > CELL_MAX ? oneLine.slice(0, CELL_MAX - 1) + '…' : oneLine;
  return { text, full, type };
}

export const JsonTable: React.FC<{ table: TabularShape; testId?: string }> = ({ table, testId }) => {
  const [page, setPage] = useState(1);
  // Cells the user opened to read in full ("row:col").
  const [openCells, setOpenCells] = useState<Set<string>>(() => new Set());
  const toggleCell = (k: string) =>
    setOpenCells((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const rows = table.rows.slice(0, page * TABLE_PAGE);
  return (
    <div data-testid={testId} className="overflow-x-auto">
      <table className="text-xs font-mono border-collapse w-full">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-2 py-1 border-b border-border/60 font-normal">#</th>
            {table.columns.map((c) => (
              <th key={c} className="px-2 py-1 border-b border-border/60 font-semibold whitespace-nowrap" title={c}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="odd:bg-muted/20 align-top">
              <td className="px-2 py-1 text-muted-foreground border-b border-border/30">{i}</td>
              {table.columns.map((c) => {
                const cell = cellText(row[c]);
                const truncated = cell.full !== cell.text;
                const cellKey = `${i}:${c}`;
                const opened = openCells.has(cellKey);
                return (
                  <td
                    key={c}
                    className={cn(
                      'px-2 py-1 border-b border-border/30 max-w-[24rem]',
                      opened ? 'whitespace-pre-wrap break-words' : 'truncate',
                      TYPE_COLOR[cell.type]
                    )}
                  >
                    {truncated ? (
                      // Truncated cells are buttons: keyboard / touch users can
                      // open the full value; the title is a bonus for mouse hover.
                      <button
                        type="button"
                        title={opened ? undefined : cell.full}
                        aria-expanded={opened}
                        onClick={() => toggleCell(cellKey)}
                        className="text-left w-full truncate hover:underline decoration-dotted"
                      >
                        {opened ? cell.full : cell.text}
                      </button>
                    ) : (
                      cell.text
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > rows.length && (
        <button
          type="button"
          onClick={() => setPage((p) => p + 1)}
          className="mt-1 text-[11px] text-opensearch-blue hover:underline"
        >
          show {Math.min(TABLE_PAGE, table.rows.length - rows.length)} more of {table.rows.length - rows.length} remaining rows…
        </button>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tabular detection: the root itself, or exactly one array-valued key of a
// root object that qualifies (the "hits"/"results"/"rows" case). Shape only —
// no key names are special-cased.
// ---------------------------------------------------------------------------

export interface TableCandidate {
  table: TabularShape;
  /** Key of the root object the table came from, or undefined for the root itself. */
  key?: string;
}

export function findTableCandidate(value: unknown): TableCandidate | undefined {
  const root = detectTabular(value);
  if (root) return { table: root };
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const candidates: TableCandidate[] = [];
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const t = detectTabular(v);
      if (t) candidates.push({ table: t, key: k });
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      // Prefer the largest one — that's the payload, the rest is metadata.
      return candidates.sort((a, b) => b.table.rows.length - a.table.rows.length)[0];
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PrettyContent
// ---------------------------------------------------------------------------

const ModeButton: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}> = ({ active, onClick, children, testId }) => (
  <button
    type="button"
    aria-pressed={active}
    data-testid={testId}
    onClick={onClick}
    className={cn(
      'px-2 py-0.5 rounded text-[11px] transition-colors',
      active ? 'bg-opensearch-blue text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    )}
  >
    {children}
  </button>
);

const CopyPretty: React.FC<{ text: string; label: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — nothing sensible to do inline */
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={copied ? 'Copied!' : label}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted"
    >
      {copied ? <Check size={11} className="text-green-500" /> : <Copy size={11} />}
      copy
    </button>
  );
};

function describeUnwrapped(n: NormalizedContent): string | null {
  const layers = n.unwrapped.filter((l) => l !== 'json-string');
  if (layers.length === 0) return null;
  const names: Record<string, string> = {
    'mcp-content': 'content envelope',
    content: 'content wrapper',
    output: 'output wrapper',
    'nested-json': 'nested JSON strings',
  };
  return `unwrapped ${layers.map((l) => names[l] ?? l).join(' → ')}`;
}

/**
 * Scalar siblings of the table key, shown above the table so choosing Table
 * doesn't hide `status: "ok" · total: 91`. Containers are left to Tree view.
 */
function scalarSiblings(root: unknown, exceptKey: string, max = 8): Array<[string, string]> {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return [];
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (k === exceptKey) continue;
    if (v !== null && typeof v === 'object') continue;
    out.push([k, formatScalar(v)]);
    if (out.length >= max) break;
  }
  return out;
}

export const PrettyContent: React.FC<PrettyContentProps> = ({
  content,
  raw,
  defaultExpandedDepth = 2,
  className,
  testId = 'pretty-content',
}) => {
  const normalized = useMemo(() => normalizeStepContent(content), [content]);
  const rawText = raw ?? normalized.raw;
  const isJson = normalized.kind === 'json';
  const tableCandidate = useMemo(() => (isJson ? findTableCandidate(normalized.value) : undefined), [isJson, normalized.value]);

  // View state is tied to the content it was chosen for: when a live step's
  // content changes shape under us (streaming assistant text that becomes
  // JSON, a tool result that arrives later) the mode, tree expansion and
  // paging must not carry over to a value they were never about.
  const initialMode: PrettyMode = isJson ? (tableCandidate ? 'table' : 'tree') : 'text';
  const [modeState, setModeState] = useState<{ mode: PrettyMode; forContent: unknown }>({ mode: initialMode, forContent: content });
  const mode = modeState.forContent === content ? modeState.mode : initialMode;
  const setMode = (m: PrettyMode) => setModeState({ mode: m, forContent: content });
  const contentVersion = useRef(0);
  const lastContent = useRef<unknown>(content);
  if (lastContent.current !== content) {
    lastContent.current = content;
    contentVersion.current += 1;
  }
  const bodyKey = contentVersion.current;

  const summary = isJson ? summarizeValue(normalized.value) : normalized.kind === 'markdown' ? 'markdown' : `text · ${normalized.raw.length} chars`;
  const unwrappedNote = describeUnwrapped(normalized);
  const truncatedNote = normalized.truncated ? 'nested parsing capped — some JSON strings left as text (see Raw)' : null;
  const pretty = useMemo(() => (isJson ? stringifyPretty(normalized.value) : String(normalized.value)), [isJson, normalized.value]);
  // Plain text that didn't unwrap anything: showing a Raw toggle would show
  // the same thing twice.
  const rawDiffers = isJson || normalized.unwrapped.length > 0;

  return (
    <div className={cn('rounded border border-border/50 bg-background/40', className)} data-testid={testId}>
      <div className="flex flex-wrap items-center gap-2 px-2 py-1 border-b border-border/40 text-[11px]">
        <span className="font-mono text-foreground/80" data-testid={`${testId}-summary`}>
          {summary}
        </span>
        {unwrappedNote && (
          <span className="text-muted-foreground/70" data-testid={`${testId}-unwrapped`}>
            · {unwrappedNote}
          </span>
        )}
        {truncatedNote && (
          <span className="text-amber-700 dark:text-amber-400" data-testid={`${testId}-truncated`}>
            · {truncatedNote}
          </span>
        )}
        <span className="flex-1" />
        <div className="flex items-center gap-0.5 bg-muted/40 rounded p-0.5" role="group" aria-label="View mode">
          {isJson && tableCandidate && (
            <ModeButton active={mode === 'table'} onClick={() => setMode('table')} testId={`${testId}-mode-table`}>
              Table
            </ModeButton>
          )}
          {isJson && (
            <ModeButton active={mode === 'tree'} onClick={() => setMode('tree')} testId={`${testId}-mode-tree`}>
              Tree
            </ModeButton>
          )}
          {!isJson && rawDiffers && (
            <ModeButton active={mode === 'text'} onClick={() => setMode('text')} testId={`${testId}-mode-text`}>
              Text
            </ModeButton>
          )}
          {rawDiffers && (
            <ModeButton active={mode === 'raw'} onClick={() => setMode('raw')} testId={`${testId}-mode-raw`}>
              Raw
            </ModeButton>
          )}
        </div>
        <CopyPretty text={mode === 'raw' ? rawText : pretty} label={mode === 'raw' ? 'Copy raw string' : 'Copy as pretty JSON'} />
      </div>

      <div className="p-2 overflow-x-auto">
        {mode === 'raw' && (
          <pre data-testid={`${testId}-raw`} className="font-mono text-xs whitespace-pre-wrap break-words max-h-[32rem] overflow-auto">
            {rawText}
          </pre>
        )}
        {mode === 'table' && tableCandidate && (
          <div>
            {tableCandidate.key !== undefined && (
              <div className="text-[11px] text-muted-foreground mb-1 font-mono flex flex-wrap gap-x-3" data-testid={`${testId}-table-context`}>
                {scalarSiblings(normalized.value, tableCandidate.key).map(([k, v]) => (
                  <span key={k}>
                    <span className="text-foreground/70">{k}</span>: <span className="text-foreground/90">{v}</span>
                  </span>
                ))}
                <span>
                  {tableCandidate.key} · {tableCandidate.table.rows.length} rows — nested keys in Tree view
                </span>
              </div>
            )}
            <JsonTable key={bodyKey} table={tableCandidate.table} testId={`${testId}-table`} />
          </div>
        )}
        {mode === 'tree' && isJson && <JsonTree key={bodyKey} value={normalized.value} defaultDepth={defaultExpandedDepth} testId={`${testId}-tree`} />}
        {mode === 'text' &&
          (normalized.kind === 'markdown' ? (
            <Markdown>{String(normalized.value)}</Markdown>
          ) : (
            <pre data-testid={`${testId}-text`} className="font-mono text-xs whitespace-pre-wrap break-words">
              {String(normalized.value)}
            </pre>
          ))}
      </div>
    </div>
  );
};

export default PrettyContent;
